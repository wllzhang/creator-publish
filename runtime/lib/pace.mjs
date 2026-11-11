/** 拟人随机停顿（ego 脚本共用） */
export function humanPause(minMs, maxMs, label = '', tag = 'pace') {
  const ms = Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  if (label) console.log(`[${tag}] ${label} → ${ms}ms`);
  return new Promise((r) => setTimeout(r, ms));
}
