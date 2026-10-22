# 配置说明

连接资料放在仓库外；在「观 → 设置 → 设备」登记，再选择用于观察的设备。服务可以包含多个容器成员，面板的四个槽位与服务定义分开保存。

## Docker 与 SSH

本机设备使用已有 Docker context；SSH 设备使用外部 profile、明确的 known_hosts 与既有身份。首次主机信任需要先由自己的 SSH 客户端确认，App 不绕过主机密钥验证。

下面仅为 JSON 结构示例。地址属于文档保留网段，路径与账户均为占位；保存为仓库外文件，并替换为自己的信息：

```json
{
  "id": "example-nas",
  "kind": "ssh",
  "host": "192.0.2.10",
  "port": 22,
  "username": "example-user",
  "knownHostsPath": "/absolute/path/to/known_hosts",
  "identityFile": "/absolute/path/to/id_ed25519",
  "dockerPath": "docker",
  "businessEndpoints": {},
  "statusEndpoints": {}
}
```

如需密码，优先使用仓库外的 `passwordRef` 或 `sudoPasswordRef` 文件。App 复用已有权限，只读取固定的 Docker 命令；远端需要可用的 timeout 或 gtimeout。不要为监测额外开放 Docker TCP socket。

## 业务状态

Docker 状态和业务状态是两个来源。通用 HTTP、论文回执、RAGFlow、Quant、组网、证书、OpenResty 各有专用合同，不能仅凭容器名自动适配任意部署。

主进程从本机 `status-sources.private.json` 读取经过核对的来源登记，设置界面仅选择既有引用，不接受任意 SQL、Shell 或远端文件路径。不同版本、网络、挂载或表结构可能需要重新核对固定 reader。没有可读来源时保持未接入，失败时保留上次结果。

## 数据目录

未设置环境变量时使用 `~/Library/Application Support/ServiceObservatory`。只有进程环境中的 `SERVICE_OBSERVATORY_DATA_DIR` 能覆盖该目录，值应为绝对路径。

`.env` 不自动读取；需要时使用 README 中的 Node `--env-file` 命令。不要把私有配置目录指向 Git 工作树。新设备测试宜使用空目录，避免加载日常监测配置。
