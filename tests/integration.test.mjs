import { test,before,after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'barbeiro-tests-'));
let processServer,base,owner,client,other,shop,service,professional,appointment;
async function request(route,{method='GET',body,cookie,origin}={}){const response=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...(origin?{origin}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
async function register(name,role){const r=await request('/register',{method:'POST',body:{name,email:name.toLowerCase()+'@example.test',password:'Test@12345',role,terms:true,shopName:'Barbearia '+name,city:'Campinas',address:'Rua de Teste, 123'}});assert.equal(r.status,200);return r.cookie;}
before(async()=>{processServer=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(path.dirname(fileURLToPath(import.meta.url))),env:{...process.env,WHATSAPP_ENABLED:'false',PORT:'0',DATABASE_PATH:path.join(dir,'test.sqlite'),SEED_DEMO:'false'},stdio:['ignore','pipe','pipe']});base=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Servidor não iniciou')),15000);processServer.stdout.on('data',d=>{out+=d;const m=out.match(/http:\/\/localhost:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});processServer.once('error',reject);processServer.stderr.on('data',d=>{if(String(d).includes('Error:'))reject(new Error(String(d)));});});});
after(async()=>{if(processServer){processServer.kill();await new Promise(resolve=>processServer.once('exit',resolve));}rmSync(dir,{recursive:true,force:true});});
test('cadastros separados e sessão sem expor senha',async()=>{owner=await register('Owner','owner');client=await register('Client','client');other=await register('Other','owner');const me=await request('/me',{cookie:owner});assert.equal(me.data.user.role,'owner');assert.equal(me.data.user.password,undefined);shop=me.data.shop.id;assert.equal((await request('/me',{cookie:client})).data.user.role,'client');});
test('senha incorreta e acesso anônimo são rejeitados',async()=>{assert.equal((await request('/login',{method:'POST',body:{email:'owner@example.test',password:'incorrect'}})).status,401);assert.equal((await request('/appointments')).status,401);});
test('clientes não podem gerenciar catálogo nem despesas',async()=>{assert.equal((await request('/services',{method:'POST',cookie:client,body:{name:'Inválido',price:10,duration:30}})).status,404);assert.equal((await request('/expenses',{cookie:client})).status,404);});
test('criar serviços e profissionais de uma empresa',async()=>{assert.equal((await request('/services',{method:'POST',cookie:owner,body:{name:'Corte + barba',price:75,duration:60}})).status,201);assert.equal((await request('/professionals',{method:'POST',cookie:owner,body:{name:'Rafael'}})).status,201);const m=await request('/manage',{cookie:owner});service=m.data.services[0].id;professional=m.data.professionals[0].id;assert.equal(m.data.services[0].price,7500);});
test('outra empresa não vê catálogo privado e não altera o serviço',async()=>{const m=await request('/manage',{cookie:other});assert.equal(m.data.services.length,0);assert.equal((await request('/services/'+service,{method:'PATCH',cookie:other,body:{name:'Ataque',price:1,duration:15}})).status,404);});
test('origem externa não pode efetuar alterações',async()=>{assert.equal((await request('/services',{method:'POST',cookie:owner,origin:'https://evil.example',body:{name:'Inválido',price:10,duration:30}})).status,403);});
test('horários levam em conta expediente, duração e dia fechado',async()=>{const slots=(await request(`/slots?shop=${shop}&service=${service}&professional=${professional}&day=2030-01-07`)).data;assert.ok(slots.includes('09:00'));assert.ok(slots.includes('18:00'));assert.ok(!slots.includes('18:15'));assert.deepEqual((await request(`/slots?shop=${shop}&service=${service}&professional=${professional}&day=2030-01-06`)).data,[]);});
test('reserva e concorrência rejeitam horários duplicados ou parcialmente sobrepostos',async()=>{const body={shop,service,professional,day:'2030-01-07',time:'10:00'};const results=await Promise.all([request('/appointments',{method:'POST',cookie:client,body}),request('/appointments',{method:'POST',cookie:client,body})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);appointment=results.find(r=>r.status===201).data.id;assert.equal((await request('/appointments',{method:'POST',cookie:client,body:{...body,time:'10:30'}})).status,409);const available=(await request(`/slots?shop=${shop}&service=${service}&professional=${professional}&day=2030-01-07`)).data;assert.ok(!available.includes('09:15'));assert.ok(available.includes('09:00'));assert.ok(available.includes('11:00'));});
test('somente o cliente e a barbearia envolvidos veem a reserva',async()=>{assert.equal((await request('/appointments',{cookie:owner})).data.length,1);assert.equal((await request('/appointments',{cookie:other})).data.length,0);assert.equal((await request('/appointments/'+appointment,{method:'PATCH',cookie:other,body:{action:'paid'}})).status,403);const stranger=await register('Stranger','client');assert.equal((await request('/appointments',{cookie:stranger})).data.length,0);assert.equal((await request('/appointments/'+appointment,{method:'PATCH',cookie:stranger,body:{action:'cancel'}})).status,403);});
test('preço de reserva é preservado depois de alterar catálogo',async()=>{await request('/services/'+service,{method:'PATCH',cookie:owner,body:{name:'Corte + barba',price:95,duration:60}});const a=(await request('/appointments',{cookie:client})).data[0];assert.equal(a.price,7500);assert.equal((await request('/manage',{cookie:owner})).data.services[0].price,9500);});
test('cliente não registra recebimento, barbearia registra uma única vez',async()=>{assert.equal((await request('/appointments/'+appointment,{method:'PATCH',cookie:client,body:{action:'paid'}})).status,403);assert.equal((await request('/appointments/'+appointment,{method:'PATCH',cookie:owner,body:{action:'paid'}})).status,200);assert.equal((await request('/appointments/'+appointment,{method:'PATCH',cookie:owner,body:{action:'paid'}})).status,400);});
test('cancelamento libera o horário e preserva o histórico',async()=>{assert.equal((await request('/appointments/'+appointment,{method:'PATCH',cookie:client,body:{action:'cancel'}})).status,200);const slots=(await request(`/slots?shop=${shop}&service=${service}&professional=${professional}&day=2030-01-07`)).data;assert.ok(slots.includes('10:00'));assert.equal((await request('/appointments',{cookie:owner})).data[0].status,'cancelled');});
test('despesas são persistidas e isoladas por barbearia',async()=>{assert.equal((await request('/expenses',{method:'POST',cookie:owner,body:{description:'Produtos',amount:120.5,day:'2030-01-07'}})).status,201);assert.equal((await request('/expenses',{cookie:owner})).data[0].amount,12050);assert.equal((await request('/expenses',{cookie:other})).data.length,0);});
test('data impossível e duração fracionária são rejeitadas',async()=>{assert.equal((await request(`/slots?shop=${shop}&service=${service}&professional=${professional}&day=2030-02-30`)).status,400);assert.equal((await request('/services',{method:'POST',cookie:owner,body:{name:'Corte',price:50,duration:30.5}})).status,400);});
test('atualização inválida de horários não altera a semana',async()=>{const hours=(await request('/manage',{cookie:owner})).data.hours;assert.equal((await request('/hours',{method:'PUT',cookie:owner,body:{hours:hours.map(h=>({...h,start:'19:00',end:'09:00'}))}})).status,400);assert.deepEqual((await request('/manage',{cookie:owner})).data.hours,hours);});
test('múltiplos serviços somam preço e tempo e preservam os itens contratados',async()=>{
 await request('/services',{method:'POST',cookie:owner,body:{name:'Barba completa',price:30,duration:30}});
 const second=(await request('/manage',{cookie:owner})).data.services.find(s=>s.name==='Barba completa');
 const services=[service,second.id],query=new URLSearchParams({shop,professional,services:services.join(','),day:'2030-01-08'});
 const available=(await request('/slots?'+query)).data;
 assert.ok(available.includes('17:30'));assert.ok(!available.includes('17:45'));
 const body={shop,professional,services,day:'2030-01-08',time:'10:00',price:1,duration:1};
 const results=await Promise.all([request('/appointments',{method:'POST',cookie:client,body}),request('/appointments',{method:'POST',cookie:client,body})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const aid=results.find(r=>r.status===201).data.id;
 const booked=(await request('/appointments',{cookie:owner})).data.find(a=>a.id===aid);
 assert.equal(booked.price,12500);assert.equal(booked.duration,90);assert.equal(booked.service_name,'Corte + barba + Barba completa');
 assert.equal((await request('/appointments',{method:'POST',cookie:client,body:{...body,time:'11:00'}})).status,409);
 await request('/services/'+second.id,{method:'PATCH',cookie:owner,body:{name:'Barba nova',price:50,duration:45}});
 await request('/services/'+second.id,{method:'DELETE',cookie:owner,body:{}});
 const history=(await request('/appointments',{cookie:client})).data.find(a=>a.id===aid);
 assert.equal(history.price,12500);assert.equal(history.duration,90);assert.equal(history.service_name,booked.service_name);
 assert.equal((await request('/appointments',{method:'POST',cookie:client,body:{...body,time:'14:00'}})).status,400);
 await request('/appointments/'+aid,{method:'PATCH',cookie:client,body:{action:'cancel'}});
 assert.ok((await request(`/slots?shop=${shop}&professional=${professional}&service=${service}&day=2030-01-08`)).data.includes('10:00'));
});
test('seleção vazia, repetida ou com serviço de outra empresa é rejeitada',async()=>{
 await request('/services',{method:'POST',cookie:other,body:{name:'Outro serviço',price:25,duration:30}});
 const foreign=(await request('/manage',{cookie:other})).data.services[0].id;
 for(const services of [[],[service,service],[service,foreign],['inexistente'],null]){
  const body={shop,professional,services,day:'2030-01-10',time:'10:00'};
  assert.equal((await request('/appointments',{method:'POST',cookie:client,body})).status,400);
 }
});
test('reservas antigas sem itens continuam visíveis com seus totais originais',async()=>{
 const fixture=new DatabaseSync(path.join(dir,'test.sqlite'));
 try{fixture.prepare("INSERT INTO appointments(id,shop_id,client_id,service_id,professional_id,day,time,duration,price) SELECT 'legacy-fixture',shop_id,client_id,service_id,professional_id,'2020-01-01','09:00',30,4200 FROM appointments LIMIT 1").run();}finally{fixture.close();}
 const old=(await request('/appointments',{cookie:owner})).data.find(a=>a.id==='legacy-fixture');
 assert.ok(old);assert.equal(old.price,4200);assert.equal(old.duration,30);assert.ok(old.service_name);
});
test('reserva com autorização cria dois avisos privados e cancelamento suspende ambos',async()=>{
 const response=await request('/appointments',{method:'POST',cookie:client,body:{shop,professional,services:[service],day:'2030-01-10',time:'10:00',whatsapp:{phone:'(11) 99999-9999',consent:true}}});
 assert.equal(response.status,201);const aid=response.data.id;
 const notices=(await request('/appointments/'+aid+'/notifications',{cookie:client})).data;
 assert.equal(notices.ready,false);assert.equal(notices.messages.length,2);assert.ok(notices.messages.every(n=>n.status==='waiting_config'));
 assert.ok(notices.messages[0].preview.includes('Corte + barba'));assert.ok(notices.messages[0].preview.includes('95,00'));
 assert.equal((await request('/appointments/'+aid+'/notifications',{cookie:other})).status,403);
 assert.equal((await request('/appointments/'+aid+'/notifications')).status,401);
 assert.equal((await request('/appointments/'+aid+'/notifications',{cookie:owner})).data.messages.length,2);
 assert.equal((await request('/me',{cookie:client})).data.whatsappPhone,'5511999999999');
 await request('/appointments/'+aid,{method:'PATCH',cookie:client,body:{action:'cancel'}});
 assert.ok((await request('/appointments/'+aid+'/notifications',{cookie:client})).data.messages.every(n=>n.status==='cancelled'));
});
test('número inválido não cria reserva; ausência de autorização não cria avisos',async()=>{
 const body={shop,professional,services:[service],day:'2030-01-11',time:'10:00',whatsapp:{phone:'123',consent:true}};
 assert.equal((await request('/appointments',{method:'POST',cookie:client,body})).status,400);
 body.whatsapp={phone:'(11) 99999-9999',consent:false};const r=await request('/appointments',{method:'POST',cookie:client,body});assert.equal(r.status,201);
 assert.deepEqual((await request('/appointments/'+r.data.id+'/notifications',{cookie:client})).data.messages,[]);
 assert.equal((await request('/webhooks/whatsapp',{method:'POST',body:{entry:[]}})).status,403);
});
test('logout invalida sessão no servidor',async()=>{assert.equal((await request('/logout',{method:'POST',cookie:owner,body:{}})).status,200);assert.equal((await request('/me',{cookie:owner})).data.user,null);});
