import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
export function createResourceStore({backend='fs', uploadDir}){
  let blob=null;
  async function init(){
    if(backend==='blob'){ blob=await import('@vercel/blob'); return; }
    await mkdir(uploadDir,{recursive:true});
  }
  async function save(storageName,buf,mime){
    if(backend==='blob'){
      const r=await blob.put(`resources/${storageName}`,buf,{access:'private',contentType:mime,addRandomSuffix:false});
      return r.pathname || `resources/${storageName}`;
    }
    await writeFile(path.join(uploadDir,path.basename(storageName)),buf); return storageName;
  }
  async function read(ref){
    if(backend==='blob'){
      const r=await blob.get(ref,{access:'private'}); if(!r) throw new Error('Blob no encontrado');
      const chunks=[]; for await (const c of r.stream) chunks.push(Buffer.from(c)); return Buffer.concat(chunks);
    }
    return readFile(path.join(uploadDir,path.basename(ref)));
  }
  async function remove(ref){
    if(!ref)return;
    if(backend==='blob'){ try{ await blob.del(ref);}catch{}; return; }
    try{await unlink(path.join(uploadDir,path.basename(ref)));}catch{}
  }
  return {backend,init,save,read,remove};
}
