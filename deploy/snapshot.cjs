// 一致性快照备份：只读连接 + VACUUM INTO。
//
// **不要用 cp**：源库有未 checkpoint 的 WAL（本地部署实测 -wal 有 4MB），
// cp 拷出来的是撕裂的库。VACUUM INTO 在只读连接上跑，产出的是完整快照。
// 由 backup.sh 在容器里调用（宿主机不需要装 better-sqlite3）。
const Database = require('/app/node_modules/better-sqlite3');
const out = process.argv[2];
const db = new Database('/data/gateway.db', { readonly: true });
db.prepare('VACUUM INTO ?').run(out);
db.close();
console.log('snapshot ok -> ' + out);
