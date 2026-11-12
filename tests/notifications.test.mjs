import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { createNotifications, createWhatsAppTransport, normalizeWhatsApp, verifySignature, whatsAppConfig } from '../notifications.mjs';

const MINUTE=60000, initial=Date.parse('2030-01-07T09:00:00-03:00');
function fixture(t,{ready=true,transport,time='12:00'}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE shops(id TEXT PRIMARY KEY,name TEXT,address TEXT);
 CREATE TABLE professionals(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE services(id TEXT PRIMARY KEY,name TEXT);
 CREATE TABLE appointments(id TEXT PRIMARY KEY,client_id TEXT,shop_id TEXT,professional_id TEXT,service_id TEXT,day TEXT,time TEXT,price INTEGER,duration INTEGER,status TEXT);
 CREATE TABLE appointment_services(appointment_id TEXT,name TEXT,position INTEGER);
 INSERT INTO users VALUES('client','Ana');INSERT INTO shops VALUES('shop','Ak Barber','Rua Antônio Gigliote, 308');
 INSERT INTO professionals VALUES('pro','Leonardo');INSERT INTO services VALUES('cut','Corte');
 INSERT INTO appointment_services VALUES('booking','Corte Degradê',0),('booking','Barba Completa',1);`);
 db.prepare('INSERT INTO appointments VALUES(?,?,?,?,?,?,?,?,?,?)').run('booking','client','shop','pro','cut','2030-01-07',time,6500,60,'confirmed');
 const sent=[];let clock=initial;
 const config={ready,phoneId:'123',confirmation:'confirmation',reminder:'reminder',language:'pt_BR'};
 const options={config,now:()=>clock,transport:transport|| (async job=>{sent.push(job);return {state:'accepted',providerId:'wamid.'+job.kind};})};
 const queue=createNotifications(db,options);
 return {db,queue,options,sent,advance:ms=>clock+=ms,rows:()=>db.prepare('SELECT * FROM appointment_notifications ORDER BY due_at').all()};
}

test('confirmação imediata e lembrete exatamente 30 minutos antes, sem duplicar',async t=>{
 const f=fixture(t);f.queue.enqueue('booking','5511999999999');f.queue.enqueue('booking','5511999999999');
 assert.equal(f.rows().length,2);assert.equal(f.rows()[1].due_at,Date.parse('2030-01-07T11:30:00-03:00'));
 await f.queue.processDue();assert.equal(f.sent.length,1);assert.equal(f.sent[0].kind,'confirmation');
 const preview=JSON.parse(f.sent[0].payload).text;
 for(const text of ['Ana','Ak Barber','Corte Degradê + Barba Completa','07/01/2030','12:00','Leonardo','60 min','65,00','Rua Antônio Gigliote, 308'])assert.ok(preview.includes(text));
 f.advance(149*MINUTE);await f.queue.processDue();assert.equal(f.sent.length,1);
 f.advance(MINUTE);await f.queue.processDue();await f.queue.processDue();assert.equal(f.sent.length,2);assert.equal(f.sent[1].kind,'reminder');
});
test('reinício e dois processadores não duplicam mensagens já aceitas',async t=>{
 const f=fixture(t);f.queue.enqueue('booking','5511999999999');
 const second=createNotifications(f.db,f.options);await Promise.all([f.queue.processDue(),second.processDue()]);assert.equal(f.sent.length,1);
 f.advance(150*MINUTE);await Promise.all([second.processDue(),f.queue.processDue()]);assert.equal(f.sent.length,2);
});
test('WhatsApp sem configuração mantém fila pendente e não faz envio',async t=>{
 const f=fixture(t,{ready:false});f.queue.enqueue('booking','5511999999999');await f.queue.processDue();
 assert.equal(f.sent.length,0);assert.ok(f.rows().every(r=>r.status==='waiting_config'));
});
test('cancelamento impede confirmação e lembrete ainda não enviados',async t=>{
 const f=fixture(t);f.queue.enqueue('booking','5511999999999');f.db.prepare("UPDATE appointments SET status='cancelled'").run();
 await f.queue.processDue();f.advance(150*MINUTE);await f.queue.processDue();assert.equal(f.sent.length,0);assert.ok(f.rows().every(r=>r.status==='cancelled'));
});
test('reserva a menos de 30 minutos recebe somente confirmação',async t=>{
 const f=fixture(t,{time:'09:20'});f.queue.enqueue('booking','5511999999999');await f.queue.processDue();
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].kind,'confirmation');assert.equal(f.rows().find(r=>r.kind==='reminder').status,'skipped');
});
test('atrasos longos e atendimentos passados expiram sem mensagens inoportunas',async t=>{
 const f=fixture(t);f.queue.enqueue('booking','5511999999999');f.advance(160*MINUTE);await f.queue.processDue();
 assert.equal(f.sent.length,0);assert.ok(f.rows().every(r=>r.status==='expired'));
});
test('falha de conexão com resultado incerto não é repetida automaticamente',async t=>{
 let attempts=0;const f=fixture(t,{transport:async()=>{attempts++;throw new Error('network');}});
 f.queue.enqueue('booking','5511999999999');await f.queue.processDue();await f.queue.processDue();assert.equal(attempts,1);assert.equal(f.rows()[0].status,'unknown');
});
test('limite temporário de envio respeita espera e tenta novamente',async t=>{
 let attempts=0;const f=fixture(t,{transport:async()=>++attempts===1?{state:'retry',code:'rate_limited'}:{state:'accepted',providerId:'wamid.retry'}});
 f.queue.enqueue('booking','5511999999999');await f.queue.processDue();await f.queue.processDue();assert.equal(attempts,1);
 f.advance(MINUTE);await f.queue.processDue();assert.equal(attempts,2);assert.equal(f.rows()[0].status,'accepted');
});
test('envio interrompido pelo encerramento do processo exige verificação',async t=>{
 const f=fixture(t);f.queue.enqueue('booking','5511999999999');f.db.prepare("UPDATE appointment_notifications SET status='sending',locked_at=? WHERE kind='confirmation'").run(initial-3*MINUTE);
 await f.queue.processDue();assert.equal(f.rows()[0].status,'unknown');assert.equal(f.sent.length,0);
});
test('entrega só é registrada com evento do número configurado e não retrocede',async t=>{
 const f=fixture(t);f.queue.enqueue('booking','5511999999999');await f.queue.processDue();
 const event=(phone,status)=>({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:phone},statuses:[{id:'wamid.confirmation',status}]}}]}]});
 f.queue.deliveryEvents(event('other','delivered'));assert.equal(f.rows()[0].status,'accepted');
 f.queue.deliveryEvents(event('123','delivered'));f.queue.deliveryEvents(event('123','failed'));f.queue.deliveryEvents(event('123','sent'));assert.equal(f.rows()[0].status,'delivered');
 assert.ok(f.queue.list('booking')[0].phone.endsWith('9999'));assert.ok(!f.queue.list('booking')[0].phone.includes('5511999999999'));
});
test('recibo recebido antes da resposta de envio preserva a entrega',async t=>{
 const f=fixture(t,{transport:async()=>{
  f.queue.deliveryEvents({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'123'},statuses:[{id:'wamid.early',status:'delivered'}]}}]}]});
  return {state:'accepted',providerId:'wamid.early'};
 }});
 f.queue.enqueue('booking','5511999999999');await f.queue.processDue();
 assert.equal(f.rows()[0].status,'delivered');assert.equal(f.rows()[0].delivered_at,initial);
});
test('valida telefone, configuração explícita e assinatura do webhook',()=>{
 assert.equal(normalizeWhatsApp('(11) 99999-9999'),'5511999999999');assert.equal(normalizeWhatsApp('+55 11 99999-9999'),'5511999999999');
 for(const v of ['',123,'abc11999999999','+1 555 123 4567'])assert.throws(()=>normalizeWhatsApp(v));
 assert.equal(whatsAppConfig({}).ready,false);assert.equal(whatsAppConfig({WHATSAPP_ENABLED:'true'}).ready,false);
 const raw=Buffer.from('{"entry":[]}'),secret='test-secret',signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
 assert.ok(verifySignature(raw,signature,secret));assert.equal(verifySignature(Buffer.from('other'),signature,secret),false);assert.equal(verifySignature(raw,'sha256=bad',secret),false);
});
test('adaptador usa template oficial e diferencia aceite de erro, sem acessar rede',async()=>{
 const config={ready:true,version:'v25.0',phoneId:'123',token:'fixture-only',confirmation:'confirm_booking',reminder:'remind_booking',language:'pt_BR'};
 let payload,url;const send=createWhatsAppTransport(config,async(u,opts)=>{url=u;payload=JSON.parse(opts.body);return new Response(JSON.stringify({messages:[{id:'wamid.fake'}]}),{status:200});});
 const job={phone:'5511999999999',kind:'confirmation',payload:JSON.stringify({parameters:['Ana','Ak Barber','Corte','07/01/2030','12:00','Leo','30 min','R$ 35,00','Rua A']})};
 assert.equal((await send(job)).state,'accepted');assert.equal(url,'https://graph.facebook.com/v25.0/123/messages');assert.equal(payload.template.components[0].parameters.length,9);assert.equal(payload.template.name,'confirm_booking');
 assert.equal((await createWhatsAppTransport(config,async()=>new Response('',{status:429}))(job)).state,'retry');
 assert.equal((await createWhatsAppTransport(config,async()=>new Response('',{status:400}))(job)).state,'failed');
 assert.equal((await createWhatsAppTransport(config,async()=>new Response('',{status:503}))(job)).state,'unknown');
});
