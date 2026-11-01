export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string,public zh?:string) {super(message);}
}
/** zh: optional Chinese text for messages with variable parts (the fixed-text table in i18n.ts cannot hold them). */
export function deny(status:number,code:string,message:string,zh?:string):never {throw new ApiError(status,code,message,zh);}
