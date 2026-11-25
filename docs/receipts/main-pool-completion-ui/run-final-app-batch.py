import json,os,shutil,subprocess,tempfile,time
from pathlib import Path
root=Path('/Users/dd/CascadeProjects/shapes-pool-app-completion');out=Path('/tmp/shapes-app-ui-preview');env=dict(os.environ,SHAPES_FWA_POOL='/Users/dd/CascadeProjects/shapes-fwa-pool-completion');results=[]
commands=[('abi-defaults-check',['node','scripts/export-main-pool-abi.mjs','--check']),('typecheck',['npm','run','typecheck']),('affected-tests',['npx','vitest','run','app/src/main-pool.test.ts','app/src/main-pool-settings.test.ts','app/src/main-pool-exit.test.ts','app/src/errors.test.ts','app/src/creation.test.ts','app/src/creation-replacement.test.ts','app/src/chain.test.ts','app/src/policy.test.ts']),('build-app',['npm','run','build:app'])]
for name,command in commands:
 log=out/('final-batch-'+name+'.log');start=time.time()
 with log.open('w') as f:run=subprocess.run(command,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
 item={'name':name,'command':command,'cwd':str(root),'exit_status':run.returncode,'elapsed_seconds':round(time.time()-start,3),'log':str(log)};results.append(item);print(json.dumps(item),flush=True)
 if run.returncode:break
with tempfile.TemporaryDirectory(prefix='main-pool-stale-export-') as folder:
 shared=Path(folder)/'shared';shared.mkdir()
 for file in ['main-pool-abi.ts','main-pool-defaults.ts']:shutil.copyfile(root/'shared'/file,shared/file)
 with (shared/'main-pool-abi.ts').open('a') as f:f.write('// deliberately stale copied ABI for validation\n')
 command=['node',str(root/'scripts/export-main-pool-abi.mjs'),'--check'];log=out/'final-batch-stale-abi-negative.log'
 with log.open('w') as f:run=subprocess.run(command,cwd=folder,env=env,stdout=f,stderr=subprocess.STDOUT)
 passed=run.returncode!=0 and 'Stale main integration output: shared/main-pool-abi.ts' in log.read_text()
 item={'name':'stale-abi-negative','command':command,'cwd':'temporary copy of shared outputs','exit_status':run.returncode,'expected':'nonzero with explicit stale ABI rejection','passed':passed,'log':str(log)};results.append(item);print(json.dumps(item),flush=True)
(out/'final-app-batch.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(0 if all((x.get('passed') if 'passed'in x else x['exit_status']==0)for x in results)and len(results)==5 else 1)
