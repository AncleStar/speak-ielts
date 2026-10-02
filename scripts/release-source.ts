import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// No env loader: private values are compared in memory and never printed.
const root = process.cwd();
const git = (...args:string[]) => execFileSync("git",args,{cwd:root,encoding:"utf8",maxBuffer:64*1024*1024,windowsHide:true});
const blocked = /(^|\/)(?:data|backups|node_modules|\.next|\.git|\.codex|\.claude|release|test-results|playwright-report|blob-report|coverage)(\/|$)|(^|\/)\.env(?:\..*)?$|\.(?:blend\d*|pem|key|p12|pfx|dump|sqlite3?|bak|zip|log)$/i;
const patterns = [
  {name:"credential-shaped value",re:/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/},
  {name:"private key block",re:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/},
  {name:"local Windows path",re:/(?<![\w-])[A-Za-z]:[\\/](?!Windows[\\/]Fonts[\\/])(?:[A-Za-z0-9_. ()-]{2,}[\\/])+/},
];
const exactSecrets:string[]=[];
const envContent=await fs.readFile(path.join(root,".env"),"utf8").catch(()=>"");
for(const line of envContent.split(/\r?\n/)){
  const match=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(!match)continue;
  const value=match[2].trim().replace(/^(["'])(.*)\1$/,"$2");
  if(/(?:KEY|SECRET|PASSWORD|TOKEN|ADMIN_EMAIL)$/.test(match[1]) && value.length>=8 && !/^(?:change-me|replace-|example|mock)/i.test(value) && !/@example\.(?:com|test)$/.test(value)) exactSecrets.push(value);
}
type Finding={file:string;rule:string};
const findings:Finding[]=[];
function scan(file:string,data:Buffer){
  const text=data.toString("utf8");
  const textFile=/\.(?:[cm]?[jt]sx?|json|md|txt|css|html|py|ps1|cmd|ya?ml|sql|sh|toml)$/.test(file)||/(?:Dockerfile|Caddyfile|LICENSE|\.env\.example)$/.test(file);
  for(const pattern of patterns){
    if(pattern.name==="local Windows path"&&!textFile)continue;
    if(pattern.re.test(text))findings.push({file,rule:pattern.name});
  }
  if(!textFile&&/[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_. -]+[\\/]/.test(text))findings.push({file,rule:"user profile path in binary metadata"});
  if(exactSecrets.some(secret=>text.includes(secret)))findings.push({file,rule:"matches local private configuration"});
}
const files=[...new Set(git("ls-files","--cached","--others","--exclude-standard","-z").split("\0").filter(Boolean))].sort();
const manifest:{file:string;bytes:number;sha256:string}[]=[];
for(const file of files){
  if(file!==".env.example"&&blocked.test(file)){findings.push({file,rule:"private/runtime file selected by Git"});continue;}
  const full=path.resolve(root,file);
  if(!full.startsWith(root+path.sep)){findings.push({file,rule:"path outside project"});continue;}
  const stat=await fs.lstat(full).catch(()=>null);if(!stat)continue;
  if(!stat.isFile()||stat.isSymbolicLink()){findings.push({file,rule:"non-regular file"});continue;}
  const data=await fs.readFile(full);scan(file,data);
  manifest.push({file,bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")});
}
// Check tracked content in every local ref as well; .gitignore does not clean history.
let historyObjects=0;
const refs=git("for-each-ref","--format=%(refname)").trim();
if(refs){
  const objects=git("rev-list","--objects","--all").trim().split(/\r?\n/).filter(Boolean);
  for(const object of objects){
    const separator=object.indexOf(" ");if(separator<0)continue;
    const oid=object.slice(0,separator),file=object.slice(separator+1);
    if(git("cat-file","-t",oid).trim()!=="blob")continue;
    historyObjects++;
    if(file!==".env.example"&&blocked.test(file))findings.push({file:`history:${file}`,rule:"private file in Git history"});
    const data=execFileSync("git",["cat-file","blob",oid],{cwd:root,maxBuffer:64*1024*1024,windowsHide:true});scan(`history:${file}`,data);
  }
}
const report={checkedAt:new Date().toISOString(),scope:"Git tracked and unignored files, all local Git refs, credential patterns and exact local sensitive env values; not a guarantee of absence of every possible secret",files:manifest.length,bytes:manifest.reduce((n,f)=>n+f.bytes,0),historyObjects,passed:findings.length===0,findings};
await fs.mkdir(path.join(root,"data/verification"),{recursive:true});
await fs.writeFile(path.join(root,"data/verification/release-scan.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(findings.length)process.exit(1);
if(process.argv.includes("--export")){
  const destination=path.join(root,"release",`speak-source-${new Date().toISOString().replace(/[:.]/g,"-")}`);
  await fs.mkdir(destination,{recursive:true});
  for(const entry of manifest){
    const target=path.join(destination,entry.file);await fs.mkdir(path.dirname(target),{recursive:true});
    const data=await fs.readFile(path.join(root,entry.file));
    if(createHash("sha256").update(data).digest("hex")!==entry.sha256)throw new Error(`File changed during export: ${entry.file}`);
    await fs.writeFile(target,data,{flag:"wx"});
  }
  await fs.writeFile(path.join(destination,"SOURCE_MANIFEST.json"),JSON.stringify({generatedAt:new Date().toISOString(),files:manifest},null,2));
  console.log(`Clean source export: ${destination}`);
}
