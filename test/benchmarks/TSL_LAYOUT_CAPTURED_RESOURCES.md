# layout Fn 捕获资源缓存：修复与性能

## 范围与结论

基于未修改 HEAD `e6b4d323d4e532371dd0ea0d7382f882ba5f5239`（r187）。
没有合入主工作区的 TextureNode、StackNode 或匿名 Fn 稳定命名修改，也没有修改主工作区或 benchmark fixture。

保留 backend → ShaderNode 缓存，分 shader stage 保存函数模板。函数体在生成时记录资源占位符及依赖；使用模板的 builder 通过正常接口登记资源、更新节点并解析实际名称。不是扫描替换首次分配的 `nodeUniform0`。

- 相同捕获 uniform 可以合法跨材质共享，更新仍会作用于各材质。
- 兼容的纯函数和捕获资源函数继续复用函数体，不必每个 builder 重新建图。
- 不透明 builder/context、attribute/varying/struct/builtin 及外部 shader flow 等尚未安全模板化的依赖，会要求当前 builder 重新生成函数；这不是禁止复用 API。
- 可复用模板只保留最近的上下文变体，不建立按材质增长的变体表。Material 版本变化会使相应模板失效。
- 首次生成与命中缓存在相同位置登记资源，避免改变 uniform 顺序而破坏 shader/pipeline 复用。
- global uniform 的局部 snippet 与 PBO 辅助变量不跨函数作用域共享；CodeNode 依赖即使已生成，也会登记到当前函数。
- layout 调用与 `.once()` 的跨 stage 状态分别缓存，不能让 fragment 使用 vertex 的 FunctionNode。

## 正确性

先在 HEAD 路径红灯：同一 Fn 捕获 uniform，第一材质回读 `[178, 128, 0, 255]`，第二材质全零；WebGL/WGSL 分别缺失 uniform / object 声明。

当前浏览器 QUnit **310 项通过，0 失败**：268 项 GLSL/WGSL 代码生成参考测试，加 42 项 TSLCore、atomic、workgroup、select 相关测试。没有修改参考快照。

新增回归覆盖：

- 同一 renderer/backend、两个独立材质，共享同一捕获 uniform 的 layout Fn；
- 预先占用不同 uniform 名称和绑定组；
- 嵌套函数、同一调用节点跨 vertex/fragment、typed `.once()`；
- texture 与 storage/PBO，及共享的 native 纹理 helper 已在同一 builder 中生成过的情况；
- 命中后源码、资源登记顺序稳定；兼容函数体仍只构建一次；
- builder/context 变化、Material 版本变化、原地变更的不透明 context 对象。

另行实际渲染检查了共享 uniform 的 onObjectUpdate，以及直接读取 builder.material 的 helper，两个后端的第二材质都读到更新后的值。

运行入口：

```sh
node utils/server.js -p 8093
```

打开 `/test/unit/UnitTests.html`，QUnit filter：

```text
/^TSL|TSLCore|storage buffer atomics|workgroup arrays and atomics|Conditional \(select\)/
```

这是实际浏览器运行，不是仅检查 compileAsync 是否 resolve。

## 测量口径

Apple M4 Pro，ego-browser / Chrome 156，WebGPURenderer 的 WebGPU 与 forceWebGL 两后端。

只读使用主工作区已有的 `test/benchmarks/threedgs-compile` server/benchmark 和固定 kiri-web fixture；在内存中适配独立 **8099** 端口，并从当前 worktree 提供 core，从 git HEAD 提供 baseline。没有抢占原性能实验服务，也没有落地复制主工作区补丁。

只测同步 `NodeBuilder.build()`，不含 builder 构造、GPU pipeline/link 或渲染等待。
每项预热 200 次，再进行 8 轮 A/B 交替，每轮 400 次；表中是各轮 mean 的中位数。
未开 profiler、未清浏览器/驱动缓存。负载为合成输入，不代表完整 kiri-web 启动。

### 已经能正确工作的纯 Fn 缓存命中

16 个材质共享同一纯算术 Fn，预热 300 次，8 轮交替、每轮 1000 次：

| 后端 | HEAD ms | 修复 ms | 函数体构建次数 |
|---|---:|---:|---|
| webgl | 0.05645 | 0.05765 | 两版均为 1 |
| webgpu | 0.05815 | 0.05855 | 两版均为 1 |

差值约 0.4–1.2 µs，约 0.7%–2.1%；源码相同。没有通过取消缓存修复问题。

### 不改变调用端写法：仍每次创建 helper

| 后端 | 负载 | HEAD ms | 修复 ms | JS build 变化 |
|---|---|---:|---:|---:|
| webgl | functions | 0.1347 | 0.1416 | +5.1% |
| webgl | sh3 | 0.8769 | 0.9354 | +6.7% |
| webgl | taau | 0.5249 | 0.5741 | +9.4% |
| webgl | pbr | 1.4304 | 1.4596 | +2.0% |
| webgpu | functions | 0.1423 | 0.1427 | +0.4% |
| webgpu | sh3 | 0.6861 | 0.7126 | +3.9% |
| webgpu | taau | 0.4702 | 0.5005 | +6.4% |
| webgpu | pbr | 1.4868 | 1.4907 | +0.3% |

最明显的额外开销在新函数首次生成时的依赖记录：本轮 SH3/TAAU 额外约 0.03–0.06 ms，最大相对变化约 9%。因此不能宣称所有路径零回归；PBR 等小幅变化也不能视作稳定收益或精确回归上限。

### 利用修复后合法的 helper 共享

| 后端 | 负载 | HEAD ms | 修复 ms | JS build 变化 |
|---|---|---:|---:|---:|
| webgl | sh3 | 0.9314 | 0.7641 | -18.0% |
| webgl | taau | 0.5557 | 0.3734 | -32.8% |
| webgpu | sh3 | 0.7489 | 0.6614 | -11.7% |
| webgpu | taau | 0.4971 | 0.3769 | -24.2% |

对照仍是 HEAD 中为绕过 bug 而每次重建 helper 的正确版本，**不是把 HEAD 的错误 shader 计为性能基线**。

实验仅在内存中让固定 fixture 的 `readSogSH` / `sampleTAAUFrame` 重用同一个 ShaderNode，模拟调用端外提 Fn；未改变采样公式、输入和资源，也未写入 fixture。这不是生产代码按函数名合并或编译器自动外提。

共享后，各项 helper 的 `flowShaderNode` 计数均为 **1**，覆盖初始化、预热和全部热构建。这里测到约 12%–33% 的 JS build 改善，不是简单沿用此前“函数体占比”的推算。

上述全部 threedgs 对照的完整 vertex/fragment 源码均相同，真实渲染回读最大通道差均为 **0**。因此这些样本没有因错误 shader、丢失函数调用或不同 pipeline 源码而制造收益。

## 边界与集成注意

1. 没有测完整场景启动、GPU 执行、移动端、Safari、严格冷缓存或长期内存留存。JS build 的改善不等于 pipeline/link 或整页同比加速。
2. 存在独立的 WGSL 首次构建问题：layout Fn 在函数内部使用默认 uv() / 捕获 varying 时可能报 `nodeVarying3` unresolved。已在未修改 HEAD 的第一个材质复现；不是本次跨 builder 缓存问题，也不是用户误用。本轮 texture 正向用例采用显式 UV。本修复未做 varying 的 closure conversion。
3. 不引入同一 shader stage 内任意多种调用上下文的函数特化，也未穷举自定义 Node 依赖未登记外部状态的行为。不透明上下文优先按 builder 失效，不猜测其可缓存性。
4. **尚未与主工作区匿名 Fn 稳定命名补丁集成。** 内部 `FunctionNode.code` 现在可能是资源模板，不能直接按未解析模板去重不同捕获资源的函数。稳定名称需基于当前 builder 解析后的源码；父函数对子函数名称的缓存引用也需要一起审查。不要直接套用两个 `buildFunctionNode` diff。
5. 未安装依赖，未运行完整单元测试或 ESLint；已做相关浏览器测试、Node 语法检查与 `git diff --check`。
