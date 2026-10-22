export type RemoteArticleReceiptFile = {
  directory: 'jobs' | 'research-requests' | 'research-queue';
  fileName: string;
  bytes: number;
  sourceAt: string | null;
  payload: unknown;
};

export type RemoteArticleReceiptRead = {
  strictReader: boolean;
  complete: boolean;
  truncated: boolean;
  totalBytes: number;
  files: RemoteArticleReceiptFile[];
  directoryCounts: Record<'jobs' | 'research-requests' | 'research-queue', number>;
  errorCode: 'source_unavailable' | 'strict_reader_unavailable' | 'incomplete' | null;
};

const ARTICLE_DIRECTORIES = new Set(['jobs', 'research-requests', 'research-queue']);
const ARTICLE_FILE = /^[0-9a-f]{64}\.json$/;

export function parseRemoteArticleReceiptRead(value: unknown): RemoteArticleReceiptRead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.strictReader !== 'boolean' || typeof record.complete !== 'boolean' || typeof record.truncated !== 'boolean') return null;
  if (typeof record.totalBytes !== 'number' || !Number.isSafeInteger(record.totalBytes) || record.totalBytes < 0 || record.totalBytes > 512 * 1024) return null;
  const errorCode = record.errorCode;
  if (errorCode !== null && errorCode !== 'source_unavailable' && errorCode !== 'strict_reader_unavailable' && errorCode !== 'incomplete') return null;
  if (!Array.isArray(record.files) || record.files.length > 128) return null;
  const directoryCounts = record.directoryCounts;
  if (!directoryCounts || typeof directoryCounts !== 'object' || Array.isArray(directoryCounts)) return null;
  const counts = {} as RemoteArticleReceiptRead['directoryCounts'];
  for (const directory of ['jobs', 'research-requests', 'research-queue'] as const) {
    const count = (directoryCounts as Record<string, unknown>)[directory];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 64) return null;
    counts[directory] = count;
  }
  const files: RemoteArticleReceiptFile[] = [];
  let totalBytes = 0;
  for (const item of record.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const file = item as Record<string, unknown>;
    if (typeof file.directory !== 'string' || !ARTICLE_DIRECTORIES.has(file.directory) || typeof file.fileName !== 'string' || !ARTICLE_FILE.test(file.fileName)) return null;
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 128 * 1024) return null;
    if (file.sourceAt !== null && (typeof file.sourceAt !== 'string' || !Number.isFinite(Date.parse(file.sourceAt)))) return null;
    totalBytes += file.bytes;
    if (totalBytes > 512 * 1024) return null;
    files.push({ directory: file.directory as RemoteArticleReceiptFile['directory'], fileName: file.fileName, bytes: file.bytes, sourceAt: file.sourceAt === null ? null : new Date(file.sourceAt).toISOString(), payload: file.payload });
  }
  if (totalBytes !== record.totalBytes) return null;
  return { strictReader: record.strictReader, complete: record.complete, truncated: record.truncated, totalBytes, files, directoryCounts: counts, errorCode: errorCode as RemoteArticleReceiptRead['errorCode'] };
}

/**
 * This is deliberately a constant remote reader. Only the root argument is
 * supplied by the private main-process source registry; the script has no
 * command, path, query, or directory input surface.
 */
export const ARTICLE_RECEIPT_PYTHON = String.raw`import datetime
import json
import os
import re
import stat
import sys

ROOT = sys.argv[1]
DIRECTORIES = ("jobs", "research-requests", "research-queue")
FILE_RE = re.compile(r"^[0-9a-f]{64}\.json$")
MAX_FILES_PER_DIRECTORY = 64
MAX_FILES_TOTAL = 128
MAX_FILE_BYTES = 128 * 1024
MAX_TOTAL_BYTES = 512 * 1024

def iso_from_ns(value):
    return datetime.datetime.fromtimestamp(value / 1_000_000_000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)

def read_one(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        return None, before.st_size, False, "nonregular_or_hardlink"
    if before.st_size > MAX_FILE_BYTES:
        return None, before.st_size, False, "file_too_large"
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    total = 0
    while True:
        chunk = os.read(fd, min(64 * 1024, MAX_FILE_BYTES + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > MAX_FILE_BYTES:
            return None, total, False, "file_too_large"
    after = os.fstat(fd)
    if identity(before) != identity(after):
        return None, total, False, "file_changed"
    try:
        value = json.loads(b"".join(chunks).decode("utf-8"))
    except Exception:
        return None, total, True, "invalid_json"
    return value, total, True, None

def read_stable(fd):
    value, size, stable, error = read_one(fd)
    if stable and error != "file_changed":
        return value, size, stable, error
    # A single bounded reread is allowed for a file that changed in place.
    value, size, stable, error = read_one(fd)
    return value, size, stable, error

def result(error_code=None):
    return {
        "schemaVersion": 1,
        "strictReader": True,
        "complete": False,
        "truncated": False,
        "totalBytes": 0,
        "files": [],
        "directoryCounts": {name: 0 for name in DIRECTORIES},
        "errorCode": error_code,
    }

def open_root_components():
    if not ROOT.startswith("/"):
        raise OSError("root must be absolute")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current_fd = os.open("/", flags)
    try:
        for component in ROOT.split("/"):
            if not component:
                continue
            if component in (".", "..") or "/" in component or "\x00" in component:
                raise OSError("unsafe root component")
            next_fd = os.open(component, flags, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise

def main():
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        return {**result("strict_reader_unavailable"), "strictReader": False}
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = None
    try:
        # Open every absolute path component from / so an ancestor symlink
        # cannot redirect the fixed reader outside the registered root.
        root_fd = open_root_components()
    except OSError:
        return result("source_unavailable")
    report = result()
    report["complete"] = True
    try:
        for directory in DIRECTORIES:
            try:
                directory_fd = os.open(directory, flags, dir_fd=root_fd)
            except OSError:
                report["complete"] = False
                report["errorCode"] = "source_unavailable"
                continue
            try:
                try:
                    names = sorted(os.listdir(directory_fd))
                except OSError:
                    report["complete"] = False
                    report["errorCode"] = "incomplete"
                    continue
                candidates = [name for name in names if isinstance(name, str) and FILE_RE.fullmatch(name)]
                if len(candidates) > MAX_FILES_PER_DIRECTORY:
                    report["truncated"] = True
                    report["complete"] = False
                    candidates = candidates[:MAX_FILES_PER_DIRECTORY]
                if len(names) != len(candidates):
                    # Temporary files and any unexpected names are not read.
                    # Their presence prevents a false claim of a complete scan.
                    report["complete"] = False
                    report["truncated"] = True
                report["directoryCounts"][directory] = len(candidates)
                for name in candidates:
                    if len(report["files"]) >= MAX_FILES_TOTAL:
                        report["truncated"] = True
                        report["complete"] = False
                        break
                    try:
                        file_fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory_fd)
                    except OSError:
                        report["complete"] = False
                        report["truncated"] = True
                        continue
                    try:
                        value, size, stable, error = read_stable(file_fd)
                        if error == "file_too_large":
                            report["complete"] = False
                            report["truncated"] = True
                            continue
                        if error in ("nonregular_or_hardlink", "file_changed") or not stable:
                            report["complete"] = False
                            report["truncated"] = True
                            continue
                        if error == "invalid_json" or value is None:
                            report["complete"] = False
                            report["truncated"] = True
                            continue
                        if report["totalBytes"] + size > MAX_TOTAL_BYTES:
                            report["complete"] = False
                            report["truncated"] = True
                            continue
                        file_stat = os.fstat(file_fd)
                        report["files"].append({
                            "directory": directory,
                            "fileName": name,
                            "bytes": size,
                            "sourceAt": iso_from_ns(file_stat.st_mtime_ns),
                            "payload": value,
                        })
                        report["totalBytes"] += size
                    finally:
                        os.close(file_fd)
            finally:
                os.close(directory_fd)
        if not report["complete"] and report["errorCode"] is None:
            report["errorCode"] = "incomplete"
        return report
    finally:
        os.close(root_fd)

try:
    print(json.dumps(main(), ensure_ascii=False, separators=(",", ":")))
except Exception:
    print(json.dumps({**result("incomplete"), "strictReader": True}, separators=(",", ":")))
`;
