/** A configured publisher is never confused with a trusted Authenticode signer. */
export function validateSignatureReport(report,version,executable,digest){
  if(report?.version!==version||!Array.isArray(report.files)||report.files.length!==2)throw new Error('Windows signature verification report is invalid.');
  const outer=report.files.find(f=>f.name===executable),inner=report.files.find(f=>f.name==='Shioaji Codex Trader.exe');
  if(!outer||!inner||outer.sha256!==digest)throw new Error('The signature report does not match the packaged executable.');
  if(report.mode==='none'){
    if(report.publisher!==null||report.files.some(f=>f.status!=='NotSigned'||f.publisher!=null||f.thumbprint!=null||f.timestamped===true||f.code_signing===true))throw new Error('An unsigned build must not claim a verified publisher.');
    return false;
  }
  if(!['pfx','store'].includes(report.mode)||typeof report.publisher!=='string'||!report.publisher.length
    ||report.files.some(f=>f.status!=='Valid'||f.timestamped!==true||f.code_signing!==true||f.publisher!==report.publisher
      ||!/^[a-fA-F0-9]{40}$/.test(f.thumbprint??'')||f.thumbprint!==outer.thumbprint))throw new Error('The Windows publisher, trusted signature or timestamp is not verified.');
  return true;
}
