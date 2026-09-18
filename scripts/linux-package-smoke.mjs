import { mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'jev-package-'));
execFileSync('npm',['install','--no-audit','--no-fund','/artifact/package.tgz'],{cwd:directory,stdio:'inherit'});
await copyFile('/artifact/smoke.mjs',join(directory,'smoke.mjs'));
execFileSync(process.execPath,['smoke.mjs','/artifact/replay.json'],{cwd:directory,stdio:'inherit'});
