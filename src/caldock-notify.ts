// New-order pings for a chat bot routine or similar HTTPS webhook, independent of the Work OS Grok Bot settings.
// The payload goes to a third party and is read by a bot, so it carries no customer name or email.
export type OrderWebhookPayload = {
  event:'caldock.order.paid'|'caldock.order.test';
  test:boolean;
  orderRef:string;
  plan:string;
  quantity:number;
  amount:string;
  stockLeft:number|null;
  adminUrl:string;
};
export type OrderWebhook = (payload:OrderWebhookPayload)=>Promise<void>;

const ATTEMPTS=2,TIMEOUT_MS=5000;

export function createOrderWebhook(rawUrl:string,secret:string,fetcher:typeof fetch=fetch):OrderWebhook {
  const url=new URL(rawUrl);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('The order webhook must be a plain HTTPS URL');
  if(!secret)throw new Error('The order webhook needs a secret');
  return async payload=>{
    let lastError:unknown;
    // A repeated ping is harmless and a lost one is not, so one quick retry even when the outcome is unknown.
    for(let attempt=0;attempt<ATTEMPTS;attempt++){
      try{
        const response=await fetcher(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(TIMEOUT_MS)});
        if(response.status===200)return;
        lastError=new Error(`Order webhook answered ${response.status}`);
      }catch(error){lastError=error;}
    }
    throw lastError;
  };
}

export function orderWebhookFromEnv(env:NodeJS.ProcessEnv):OrderWebhook|null {
  const url=env.CALDOCK_ORDER_WEBHOOK_URL?.trim(),secret=env.CALDOCK_ORDER_WEBHOOK_SECRET?.trim();
  if(!url||!secret)return null;
  // A bad value disables this ping only; it must never stop the shared Work OS service.
  try{return createOrderWebhook(url,secret);}
  catch(error){console.error('CalDock order webhook disabled: '+(error as Error).message);return null;}
}
