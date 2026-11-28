# newsupu
新规则
模块：https://raw.githubusercontent.com/xepes0/wloc/refs/heads/main/modules/wloc.module 位置更新



订阅地址：
https://raw.githubusercontent.com/Zalozheng/newsupu/refs/heads/main/autossr.conf


# Shadowrocket 本地化配置使用说明

## 运行后都要在运行一次4 去重

每次执行完 **选项 1（仅编译）** 或 **选项 2（全量更新并编译）** 后，都请再运行一次 **选项 4（去重）**，以清理重复及被前序规则覆盖的冗余域名/IP。

---

## 目录说明

* `template.conf`：主配置模板（改节点分组、加减规则、加远程规则集、改重写/MITM 全都改这个文件）
* `一键更新规则与脚本.command`：双击运行的更新、编译与去重工具
* `Rules/`：本地缓存的规则集文件
* `Scripts/`：本地缓存的 JS 脚本文件
* `autossr_local.conf`：自动编译生成的最终离线配置文件（同时会自动同步到 iCloud Shadowrocket 目录）

## 双击 `一键更新规则与脚本.command` 选项说明

1. **仅编译**：优先复用本地 `Rules/` 与 `Scripts/` 缓存，仅自动补下载本地缺失的新链接，生成 `autossr_local.conf`。
2. **全量更新并编译**：从 GitHub 重新拉取模板中的全部远程规则集与 JS 脚本后编译生成 `autossr_local.conf`。
3. **仅更新 JS 脚本**：只更新模板里的远程 JS 脚本，并同步到 iCloud 的 `Shadowrocket/Script/`。
4. **清理重复规则**：按从上到下优先级保留排在前面的规则，自动删除后方重复及已被前序 `DOMAIN-SUFFIX` 覆盖的冗余规则，并同步覆盖到本目录与 iCloud。

## 生效步骤

1. 修改 `template.conf`（如需修改）。
2. 双击 `一键更新规则与脚本.command`，选 `1` 或 `2` 生成配置。
3. **再次双击运行，选 `4` 完成去重。**
4. 打开 Shadowrocket → **配置** → 点击 `autossr_local.conf` → **使用配置 / 编译配置**。