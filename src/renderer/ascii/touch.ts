import leftHandAsset from './assets/ascii-touch-left.png';
import rightHandAsset from './assets/ascii-touch-right.png';

export const ASCII_TOUCH_DURATION_MS = 8_300;
export const ASCII_TOUCH_STATIC_FRAME_MS = 3_230;

const HAND_WIDTH = 1_510;
const HAND_HEIGHT = 992;
const SCENE_WIDTH = HAND_WIDTH * 2;
const SCENE_HEIGHT = HAND_HEIGHT;
const TOUCH_HAND_COLOR = '#b8d3bb';
const TOUCH_WAVE_COLOR = '#d5ead8';
const TOUCH_FLASH_COLOR = '#e6f2e7';
const WAVE_GLYPHS = ['.', ':', '+', '*'] as const;

export const ASCII_TOUCH_ASSETS = [leftHandAsset, rightHandAsset] as const;

export type TouchImagePair = readonly [CanvasImageSource, CanvasImageSource];

export type TouchDrawOptions = {
  intensity: number;
  qualityLevel?: 0 | 1 | 2;
  staticFrame?: boolean;
};

type TouchFrame = {
  time: number;
  width: number;
  height: number;
  arrival: number;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  entryShift: number;
  touchShift: number;
  centerX: number;
  centerY: number;
};

let tintedImagesPromise: Promise<TouchImagePair> | undefined;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function smooth(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function phase(time: number, from: number, to: number) {
  return smooth((time - from) / (to - from));
}

function hash(value: number) {
  const sample = Math.sin(value * 127.1 + 34.7) * 43_758.5453;
  return sample - Math.floor(sample);
}

function normalizeTime(elapsedMs: number) {
  return ((elapsedMs % ASCII_TOUCH_DURATION_MS) + ASCII_TOUCH_DURATION_MS) % ASCII_TOUCH_DURATION_MS;
}

export function touchFrameAt(elapsedMs: number, width: number, height: number, staticFrame = false): TouchFrame {
  const time = staticFrame ? ASCII_TOUCH_STATIC_FRAME_MS : normalizeTime(elapsedMs);
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(safeHeight / 1_542, safeWidth / 1_200);
  const sceneWidth = SCENE_WIDTH * scale;
  const offsetX = (safeWidth - sceneWidth) / 2;
  const offsetY = (safeHeight - SCENE_HEIGHT * scale) / 2 - 550 * scale;
  const arrival = staticFrame ? 1 : phase(time, 400, 2_890);
  const opacity = staticFrame ? 1 : phase(time, 550, 2_160);
  const entryShift = (safeWidth / 2 + 35) * (1 - arrival);
  const touchShift = 31 * scale * arrival;
  return {
    time,
    width: safeWidth,
    height: safeHeight,
    arrival,
    opacity,
    scale,
    offsetX,
    offsetY,
    entryShift,
    touchShift,
    centerX: safeWidth / 2,
    centerY: offsetY + 1_055 * scale,
  };
}

function createTintedImage(source: string) {
  const image = new Image();
  image.decoding = 'async';
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    image.addEventListener('load', () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('无法创建ASCII背景图层缓存'));
        return;
      }
      context.drawImage(image, 0, 0);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = TOUCH_HAND_COLOR;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'source-over';
      resolve(canvas);
    }, { once: true });
    image.addEventListener('error', () => reject(new Error('ASCII背景图层加载失败')), { once: true });
    image.src = source;
  });
}

export function loadTintedAsciiTouchImages() {
  if (!tintedImagesPromise) {
    tintedImagesPromise = Promise.all(ASCII_TOUCH_ASSETS.map((asset) => createTintedImage(asset)))
      .then((images) => [images[0]!, images[1]!] as const);
  }
  return tintedImagesPromise;
}

function drawSpark(context: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number, rotation = 0) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.globalAlpha = alpha;
  context.fillStyle = TOUCH_FLASH_COLOR;
  context.beginPath();
  context.moveTo(0, -size);
  context.quadraticCurveTo(size * .16, -size * .16, size, 0);
  context.quadraticCurveTo(size * .16, size * .16, 0, size);
  context.quadraticCurveTo(-size * .16, size * .16, -size, 0);
  context.quadraticCurveTo(-size * .16, -size * .16, 0, -size);
  context.fill();
  context.restore();
}

function drawFlash(context: CanvasRenderingContext2D, frame: TouchFrame, intensity: number) {
  const { time, scale, centerX, centerY } = frame;
  const appear = phase(time, 2_790, 2_910);
  const fade = 1 - phase(time, 3_750, 4_300);
  const strength = appear * fade * clamp(.32 + intensity * .48, .28, .78);
  if (strength <= 0) return;
  const expansion = phase(time, 2_890, 3_750);
  const radius = (120 + expansion * 345) * scale;

  context.save();
  context.globalCompositeOperation = 'screen';
  const halo = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  halo.addColorStop(0, `rgba(230,242,231,${.74 * strength})`);
  halo.addColorStop(.08, `rgba(214,235,217,${.52 * strength})`);
  halo.addColorStop(.33, `rgba(175,211,185,${.22 * strength})`);
  halo.addColorStop(1, 'rgba(175,211,185,0)');
  context.fillStyle = halo;
  context.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
  context.restore();

  const rayLength = (95 + 255 * expansion) * scale;
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4 + (index % 2 ? .07 : 0);
    const length = rayLength * (index % 2 ? .62 : 1);
    const breadth = (index % 2 ? 5 : 9) * scale * strength;
    context.save();
    context.translate(centerX, centerY);
    context.rotate(angle);
    context.globalAlpha = .42 * strength;
    context.fillStyle = TOUCH_FLASH_COLOR;
    context.beginPath();
    context.moveTo(0, -breadth);
    context.quadraticCurveTo(length * .5, -breadth * .22, length, 0);
    context.quadraticCurveTo(length * .5, breadth * .22, 0, breadth);
    context.fill();
    context.restore();
  }

  drawSpark(context, centerX, centerY, (52 + 125 * expansion) * scale, .65 * strength);
  for (let index = 0; index < 22; index += 1) {
    const angle = hash(index + 8) * Math.PI * 2;
    const distance = (56 + hash(index + 28) * 340 * expansion) * scale;
    const x = centerX + Math.cos(angle) * distance;
    const y = centerY + Math.sin(angle) * distance * .78;
    const opacity = strength * (.22 + hash(index + 99) * .38);
    if (index % 3 === 0) {
      drawSpark(context, x, y, (7 + hash(index) * 13) * scale, opacity, angle);
    } else {
      context.globalAlpha = opacity;
      context.fillStyle = TOUCH_FLASH_COLOR;
      context.font = `${Math.max(10, 24 * scale)}px monospace`;
      context.fillText(index % 2 ? '+' : '·', x, y);
    }
  }
  context.globalAlpha = 1;
}

function drawImpact(context: CanvasRenderingContext2D, frame: TouchFrame, intensity: number, qualityLevel: 0 | 1 | 2) {
  const { time, width, height, scale, centerX, centerY } = frame;
  if (time < 2_870) {
    drawFlash(context, frame, intensity);
    return;
  }
  if (time >= 6_400) return;

  const progress = clamp((time - 2_870) / (6_400 - 2_870), 0, 1);
  const farX = Math.max(centerX, width - centerX) * .78;
  const farY = Math.max(centerY, height - centerY) * 1.25;
  const radius = (Math.hypot(farX, farY) + 110) * (1 - (1 - progress) ** 1.35);
  const cell = clamp(Math.round(Math.min(width, height) / 65) + qualityLevel * 2, 8, 16);
  const band = Math.max(49, Math.min(width, height) * .105);
  const wobble = Math.max(9, Math.min(width, height) * .025);
  const tail = 1 - phase(time, 5_650, 6_400);
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.globalAlpha = 1;
  for (let row = 0, y = 0; y < height; row += 1, y += cell) {
    for (let column = 0, x = 0; x < width; column += 1, x += cell) {
      const dx = x + cell / 2 - centerX;
      const dy = y + cell / 2 - centerY;
      const angle = Math.atan2(dy, dx);
      const distance = Math.hypot(dx * .78, dy * 1.25);
      const front = radius + wobble * (
        .56 * Math.sin(angle * 7 + time * .0017) +
        .29 * Math.sin(angle * 13 - time * .0012) +
        .15 * Math.sin(angle * 23 + time * .0008)
      );
      const number = row * 8_191 + column * 131;
      const jitter = (hash(number + 17) - .5) * cell * 2.5;
      if (distance - front < -band * 1.3 + jitter) context.fillRect(x, y, cell + .5, cell + .5);
    }
  }
  context.restore();

  drawFlash(context, frame, intensity);
  if (tail <= 0) return;
  const glyphs: Array<{ x: number; y: number; char: string; alpha: number }> = [];
  for (let row = 0, y = 0; y < height; row += 1, y += cell) {
    for (let column = 0, x = 0; x < width; column += 1, x += cell) {
      const dx = x + cell / 2 - centerX;
      const dy = y + cell / 2 - centerY;
      const angle = Math.atan2(dy, dx);
      const distance = Math.hypot(dx * .78, dy * 1.25);
      const front = radius + wobble * (
        .56 * Math.sin(angle * 7 + time * .0017) +
        .29 * Math.sin(angle * 13 - time * .0012) +
        .15 * Math.sin(angle * 23 + time * .0008)
      );
      const number = row * 8_191 + column * 131;
      const delta = distance - front;
      const envelope = delta >= 0
        ? Math.max(0, 1 - delta / band)
        : Math.max(0, 1 + delta / (band * 2.2));
      if (!envelope) continue;
      const crest = .18 + .82 * Math.max(0, Math.cos(delta / 13)) ** 1.5;
      const flow = .28 + .72 * (.5 + .5 * Math.sin(angle * 5 + 1.5 * Math.sin(angle * 2) + time * .0012));
      const brightness = envelope * crest * flow * tail;
      if (hash(number + 73) > brightness * 1.12) continue;
      const choice = hash(number + 211);
      const glyph = choice > .88 ? WAVE_GLYPHS[3] : choice > .6 ? WAVE_GLYPHS[2] : choice > .3 ? WAVE_GLYPHS[1] : WAVE_GLYPHS[0];
      glyphs.push({
        x: x + cell * (.3 + hash(number + 3) * .35),
        y: y + cell * (.65 + hash(number + 5) * .2),
        char: glyph,
        alpha: brightness * (.18 + intensity * .42) * (.65 + hash(number + 97) * .35),
      });
    }
  }
  context.fillStyle = TOUCH_WAVE_COLOR;
  context.font = `600 ${Math.max(10, cell * 1.14)}px monospace`;
  for (const glyph of glyphs) {
    context.globalAlpha = glyph.alpha;
    context.fillText(glyph.char, glyph.x, glyph.y);
  }
  context.globalAlpha = 1;
}

export function drawAsciiTouchFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsedMs: number,
  images: TouchImagePair | null,
  options: TouchDrawOptions,
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  context.clearRect(0, 0, safeWidth, safeHeight);
  if (!images) return;

  const frame = touchFrameAt(elapsedMs, safeWidth, safeHeight, options.staticFrame);
  if (!options.staticFrame && frame.time >= 6_400) return;
  const opacity = frame.opacity * clamp(.28 + options.intensity * .68, .32, .82);
  context.save();
  context.globalAlpha = opacity;
  context.imageSmoothingEnabled = true;
  context.drawImage(images[0], frame.offsetX - frame.entryShift + frame.touchShift, frame.offsetY + 550 * frame.scale, HAND_WIDTH * frame.scale, HAND_HEIGHT * frame.scale);
  context.drawImage(images[1], frame.offsetX + HAND_WIDTH * frame.scale + frame.entryShift - frame.touchShift, frame.offsetY + 550 * frame.scale, HAND_WIDTH * frame.scale, HAND_HEIGHT * frame.scale);
  context.restore();

  if (options.staticFrame) drawFlash(context, frame, options.intensity);
  else drawImpact(context, frame, options.intensity, options.qualityLevel ?? 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
}
