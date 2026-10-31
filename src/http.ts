/** Bound response memory even when an upstream omits or lies about Content-Length. */
export async function boundedJson(response:Response,maxBytes=1_000_000):Promise<unknown>{
 if(!response.body)throw Error('empty_response');const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBytes)throw Error('response_too_large');chunks.push(part.value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
