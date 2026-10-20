import {execFileSync} from 'node:child_process';

// Release collections include every asset; a staged replacement plus old releases exceeds 1 MiB.
export const captureCommand=(file,args)=>execFileSync(file,args,{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024,
});
