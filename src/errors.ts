export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string,public zh?:string,public details?:unknown) {super(message);}
}
/** Like deny, with structured details for the client (for example per-field validation issues). */
export function denyWith(status:number,code:string,message:string,zh:string,details:unknown):never {throw new ApiError(status,code,message,zh,details);}
/** zh: optional Chinese text for messages with variable parts (the fixed-text table in i18n.ts cannot hold them). */
export function deny(status:number,code:string,message:string,zh?:string):never {throw new ApiError(status,code,message,zh);}
