import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
for(const name of ['close-review','source-quality','source-ingress','personal-work','staff-lender-access','protected-payloads','recovery-manifest','lifecycle','retention-storage']){
 console.log(`Running ${name} checks`);
 const result=spawnSync(process.execPath,['scripts/node_modules/tsx/dist/cli.mjs',`artifacts/api-server/tests/${name}.test.ts`],{cwd:root,env:{...process.env,DATABASE_URL:process.env.DATABASE_URL||'postgres://unused:unused@127.0.0.1:1/unused'},stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
