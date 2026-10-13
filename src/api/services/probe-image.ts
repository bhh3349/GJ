// 能力探测（契约 §5）的**内置小图**：32×32 真 PNG，data URL 内嵌。
//
// 探测请求体由服务端内置（契约「2xx 的吹哨纪律」）：把这张图与请求一起钉死在服务端，
// 调用方没有任何注入面。生成方式（node:zlib 手搓 PNG，零依赖、可复跑）：
//   32×32 RGB、每行 filter 0 + 3 字节/像素的对角双色方块，deflate level 9；
//   手写 IHDR/IDAT/IEND chunk 与 CRC32。base64 共 184 字符，PNG 本体 137 字节。
// 生成脚本曾存于 .ekko-tmp（一次性脚手架，不入仓）：gen-probe-png.mjs。
export const PROBE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAUElEQVR42mOQz78CRy/ef4Ijaokz0NR0+fwrDDQ1HWoB7UwHWUBT01EsoFFsM9DUdKgFNE2pDKP5YDQfjOaD0Xwwmg9G88FoPhjNB6P5AIwA5DZWed//MYUAAAAASUVORK5CYII=';
