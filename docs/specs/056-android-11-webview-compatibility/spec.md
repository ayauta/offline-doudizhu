# Spec 056：Android 11 / WebView 90 兼容性

状态：用户确认，实施中  
日期：2026-09-19

## 目标

保持系统 WebView 与现有轻量 Android 外壳，在 Android 11、System WebView
90.0.4430.210 上修复连续划过手牌只切换一张牌的问题，并建立可持续的运行时
兼容检查。浏览器/PWA 与 Android 继续共享同一份静态应用输出，不引入自带浏览器
内核或全局 polyfill 包。

## 行为要求

- 从一张牌开始横向划过多张牌时，经过的每张牌都按起点状态统一选中或取消。
- 快速的一次 pointer move、反向划动、移出手牌区域后重新进入均不能漏掉实际经过
  的牌。
- pointer cancel 不得产生一次单击效果；未超过移动阈值的单击仍只切换起点牌。
- 出牌后的手牌重排动画在支持 Web Animations API 的基线 WebView 上使用兼容的
  `transform` 关键帧；动画不可用时，牌序和最终布局仍必须正确。
- 出牌、提示、重开与前后台切换的既有行为不得回归。

## 兼容基线与门禁

- Android 发布运行时基线明确为 Android 10 或更新版本上的 Chrome/System
  WebView 90；构建语法目标继续为 `chrome74`，以保留现有语法转译余量。
- TypeScript 的 ECMAScript 类型库不得高于 ES2021。应用运行时源码不得直接使用
  WebView 90 缺失的 `Array.prototype.at`、`Object.hasOwn` 或已知更晚的内建。
- DOM 与 CSS 能力不受 ECMAScript `lib` 年份约束，须由项目兼容检查维护明确的
  禁用项；当前至少禁止 Web Animations 关键帧中的独立 `translate` 属性。
- 不加入大体积或全局 polyfill。可用等价的兼容写法时直接使用；只有出现真正
  共享且复杂的兼容行为时才建立运行时兼容模块。

## 验证

- Vitest 保留纯指针状态机对正向、反向、离开后返回、取消和单击的确定性覆盖。
- Playwright 在主动移除 `Array.prototype.at` 与 `Object.hasOwn` 的页面环境中运行
  真实手势，证明事件处理路径不依赖这些能力，并继续覆盖快速跨牌与重排动画。
- `pnpm check` 必须执行静态 WebView 兼容门禁。
- 真机 CDP 探针报告基线能力、页面异常与关键交互结果；输出不得包含设备序列号。
- 重新构建并检查 debug APK，运行既有 emulator shell smoke；真机安装后再人工
  抽查滑动多选、出牌、提示、重开、前后台切换。人工触感与舒适度结论不得描述
  为自动化能力。

