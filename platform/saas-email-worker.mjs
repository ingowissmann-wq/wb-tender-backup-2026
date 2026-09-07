export async function deliverBookingEmail(pool, adapter) {
  const item=(await pool.query('SELECT * FROM saas.claim_booking_email()')).rows[0];
  if(!item?.id)return {processed:false};
  let delivered=false;
  try { await adapter.sendBookingConfirmation({to:item.recipient,bookingId:item.booking_id,...item.payload}); delivered=true; }
  catch { /* Only a fixed failure code is persisted; never SMTP credentials or recipient data. */ }
  const result=await pool.query('SELECT saas.finish_booking_email($1,$2,$3) finished',[item.id,item.lease_token,delivered]);
  if(result.rows[0]?.finished!==true)throw new Error('booking_email_lease_lost');
  return {processed:true,delivered,attempts:item.attempts};
}

export function startBookingEmailWorker(pool, adapter, {logger,intervalMs=5000}={}) {
  let stopping=false,timer,running;
  const tick=async()=>{
    try {
      for(let i=0;i<20&&!stopping;i++){
        const result=await deliverBookingEmail(pool,adapter);
        if(!result.processed)break;
        if(!result.delivered)logger?.error({code:'booking_email_delivery_failed',attempt:result.attempts,terminal:result.attempts>=10},'Booking email delivery failed');
      }
    } catch {logger?.error({code:'booking_email_dispatch_failed'},'Booking email dispatcher failed');}
    finally {if(!stopping){timer=setTimeout(()=>{running=tick();},intervalMs);timer.unref();}}
  };
  running=tick();
  return {async stop(){stopping=true;clearTimeout(timer);await running;}};
}
