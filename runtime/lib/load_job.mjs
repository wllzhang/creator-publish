import fs from 'fs';
import os from 'os';
import path from 'path';

/** 默认 job 落点：%TEMP%/creator-publish-job.json */
export function defaultJobPath() {
  return path.join(os.tmpdir(), 'creator-publish-job.json');
}

/**
 * 读发布任务。优先级：
 * 1. --job=path / --job path（process.argv）
 * 2. env CREATOR_PUBLISH_JOB
 * 3. 默认 TEMP 路径
 */
export function loadJob(argv = process.argv.slice(2)) {
  let jobPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--job=')) jobPath = a.slice('--job='.length);
    else if (a === '--job' && argv[i + 1]) jobPath = argv[++i];
  }
  if (!jobPath) jobPath = process.env.CREATOR_PUBLISH_JOB || defaultJobPath();
  jobPath = path.resolve(jobPath);
  if (!fs.existsSync(jobPath)) {
    throw new Error(
      `找不到 job 文件: ${jobPath}\n先运行: node runtime/write_job.mjs ... 或设置 CREATOR_PUBLISH_JOB`,
    );
  }
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  if (!job.profileId) job.profileId = 'Profile 2';
  if (!job.mode) job.mode = 'draft';
  console.log('[job]', jobPath, JSON.stringify({ platform: job.platform, mode: job.mode, profileId: job.profileId }));
  return { job, jobPath };
}

export function abs(p) {
  if (!p) return p;
  return path.resolve(String(p).replace(/\//g, path.sep)).replace(/\\/g, '/');
}
