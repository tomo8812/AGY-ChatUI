export async function sha256Text(value:string):Promise<string>{
  if(!globalThis.crypto?.subtle)throw Error('安全な接続で開いてください。');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
