import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createNotifications, normalizeWhatsApp, verifySignature } from './notifications.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root,'.env.whatsapp')); } catch(error) { if(error.code!=='ENOENT')throw error; }
const databasePath = process.env.DATABASE_PATH || path.join(root, 'data', 'barbeiro.sqlite');
mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('client','owner')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,city TEXT NOT NULL,address TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',lat REAL,lng REAL,image INTEGER NOT NULL DEFAULT 0,demo INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS services(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),name TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>0),duration INTEGER NOT NULL CHECK(duration>=15 AND duration<=240),active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS professionals(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS hours(shop_id TEXT NOT NULL REFERENCES shops(id),weekday INTEGER NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(shop_id,weekday));
CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),client_id TEXT NOT NULL REFERENCES users(id),service_id TEXT NOT NULL REFERENCES services(id),professional_id TEXT NOT NULL REFERENCES professionals(id),day TEXT NOT NULL,time TEXT NOT NULL,duration INTEGER NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',payment TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS appointments_slots ON appointments(professional_id,day,status);`);
db.exec(`CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),description TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),day TEXT NOT NULL);`);
// Additive migration: existing single-service appointments remain untouched.
db.exec(`CREATE TABLE IF NOT EXISTS appointment_services(
 appointment_id TEXT NOT NULL REFERENCES appointments(id),
 service_id TEXT NOT NULL REFERENCES services(id),
 name TEXT NOT NULL,price INTEGER NOT NULL,duration INTEGER NOT NULL,position INTEGER NOT NULL,
 PRIMARY KEY(appointment_id,service_id));`);
const all=(sql,...p)=>db.prepare(sql).all(...p),one=(sql,...p)=>db.prepare(sql).get(...p),run=(sql,...p)=>db.prepare(sql).run(...p);
const notifications=createNotifications(db);
const hash=password=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');};
const verify=(password,stored)=>{const [salt,key]=stored.split(':');return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(key,'hex'));};
const id=()=>randomUUID();
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,min=1,max=160)=>{if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)fail('Preencha corretamente todos os campos.');return v.trim();};
const number=(v,min,max)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)fail('Valor inválido.');return n;};
const mins=t=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))fail('Horário inválido.');return Number(t.slice(0,2))*60+Number(t.slice(3));};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
function dayValue(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v+'T12:00:00Z'))||new Date(v+'T12:00:00Z').toISOString().slice(0,10)!==v)fail('Data inválida.');return v;}
function shopOwned(user){if(!user||user.role!=='owner')fail('Acesso exclusivo da barbearia.',403);const s=one('SELECT * FROM shops WHERE owner_id=?',user.id);if(!s)fail('Barbearia não encontrada.',404);return s;}
function selectedServices(shopId,selection){
 const ids=typeof selection==='string'?[selection]:selection;
 if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(v=>typeof v!=='string'||!v)||new Set(ids).size!==ids.length)fail('Selecione pelo menos um serviço, sem repetições (máximo de 20).');
 return ids.map(sid=>{const service=one('SELECT * FROM services WHERE id=? AND shop_id=? AND active=1',sid,shopId);if(!service)fail('Um dos serviços não está disponível nesta barbearia.');return service;});
}
function slots(shopId,professionalId,selection,day){
 dayValue(day);
 const services=selectedServices(shopId,selection),duration=services.reduce((sum,s)=>sum+s.duration,0);
 const pro=one('SELECT * FROM professionals WHERE id=? AND shop_id=? AND active=1',professionalId,shopId);
 if(!pro)fail('Selecione um profissional válido.');
 const h=one('SELECT * FROM hours WHERE shop_id=? AND weekday=?',shopId,new Date(day+'T12:00:00Z').getUTCDay());
 if(!h||h.closed||day<today())return [];
 const busy=all("SELECT * FROM appointments WHERE professional_id=? AND day=? AND status!='cancelled'",professionalId,day),result=[];
 for(let m=mins(h.start);m+duration<=mins(h.end);m+=15){
  const time=String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  if(new Date(day+'T'+time+':00-03:00')<=new Date())continue;
  if(!busy.some(b=>m<mins(b.time)+b.duration&&m+duration>mins(b.time)))result.push(time);
 }
 return result;
}
function createShop(ownerId,name,city,address,demo=0,image=0){const sid=id();run('INSERT INTO shops(id,owner_id,name,city,address,demo,image) VALUES(?,?,?,?,?,?,?)',sid,ownerId,name,city,address,demo,image);for(let d=0;d<7;d++)run('INSERT INTO hours VALUES(?,?,?,?,?)',sid,d,'09:00','19:00',d===0?1:0);return sid;}
if(!one('SELECT id FROM shops LIMIT 1')&&process.env.SEED_DEMO!=='false'){
 const owner=id();run('INSERT INTO users VALUES(?,?,?,?,?)',owner,'Rafael Oliveira','barbeiro@demo.local',hash('Demo@12345'),'owner');const sid=createShop(owner,'Studio Navalha','São Paulo','Rua Augusta, 1450 · Consolação',1,0);run('UPDATE shops SET lat=?,lng=?,description=? WHERE id=?',-23.555,-46.658,'Cortes precisos, conversa boa e um tempo só seu. Especialistas em corte clássico, degradê e barba.',sid);
 for(const [name,price,duration] of [['Corte masculino',4500,30],['Barba & toalha quente',3500,30],['Corte + barba',7500,60],['Acabamento',2000,15]])run('INSERT INTO services(id,shop_id,name,price,duration) VALUES(?,?,?,?,?)',id(),sid,name,price,duration);
 for(const name of ['Rafael Oliveira','Lucas Santos','Bruno Costa'])run('INSERT INTO professionals(id,shop_id,name) VALUES(?,?,?)',id(),sid,name);
 const client=id();run('INSERT INTO users VALUES(?,?,?,?,?)',client,'Gabriel Almeida','cliente@demo.local',hash('Demo@12345'),'client');
 for(const [i,name,address,lat,lng] of [[1,'Barbearia Origem','Rua dos Pinheiros, 870 · Pinheiros',-23.568,-46.686],[2,'Distrito Barber Club','Alameda Santos, 980 · Jardins',-23.567,-46.653]]){const uid=id();run('INSERT INTO users VALUES(?,?,?,?,?)',uid,name,`shop${i}@demo.local`,hash(randomBytes(32).toString('hex')),'owner');const shop=createShop(uid,name,'São Paulo',address,1,i);run('UPDATE shops SET lat=?,lng=?,description=? WHERE id=?',lat,lng,'Seu próximo visual começa aqui. Atendimento com hora marcada e atenção em cada detalhe.',shop);run('INSERT INTO services(id,shop_id,name,price,duration) VALUES(?,?,?,?,?)',id(),shop,'Corte masculino',i===1?5500:6000,45);run('INSERT INTO professionals(id,shop_id,name) VALUES(?,?,?)',id(),shop,'Equipe '+name);}
}
const attempts=new Map();
function limit(key){const now=Date.now();for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);const v=attempts.get(key)||{count:0,until:now+900000};if(++v.count>30)fail('Muitas tentativas. Aguarde 15 minutos.',429);attempts.set(key,v);}
function json(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>16000)fail('Requisição muito grande.',413);}try{return JSON.parse(s||'{}');}catch{fail('JSON inválido.');}}
async function whatsappWebhook(req,res,url){
 const config=notifications.config;
 if(req.method==='GET'){
  if(!config.verifyToken||url.searchParams.get('hub.mode')!=='subscribe'||url.searchParams.get('hub.verify_token')!==config.verifyToken)fail('Verificação inválida.',403);
  res.writeHead(200,{'Content-Type':'text/plain'});return res.end(url.searchParams.get('hub.challenge')||'');
 }
 if(req.method!=='POST')fail('Método não permitido.',405);
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>262144)fail('Requisição muito grande.',413);chunks.push(chunk);}
 const raw=Buffer.concat(chunks);
 if(!verifySignature(raw,req.headers['x-hub-signature-256'],config.appSecret))fail('Assinatura inválida.',403);
 let data;try{data=JSON.parse(raw.toString('utf8'));}catch{fail('JSON inválido.');}
 notifications.deliveryEvents(data);return json(res,200,{ok:true});
}
function login(res,uid){const token=randomBytes(32).toString('hex');run('DELETE FROM sessions WHERE expires<?',Date.now());run('INSERT INTO sessions VALUES(?,?,?)',token,uid,Date.now()+604800000);json(res,200,{ok:true},{'Set-Cookie':`session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`});}
async function api(req,res,url){const token=(req.headers.cookie||'').match(/(?:^|; )session=([a-f0-9]+)/)?.[1];const user=token?one('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',token,Date.now()):null;const p=url.pathname,method=req.method;
 if(p==='/api/webhooks/whatsapp')return whatsappWebhook(req,res,url);
 if(method!=='GET'){const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)fail('Origem não permitida.',403);if(!String(req.headers['content-type']).startsWith('application/json'))fail('Formato inválido.',415);}
 if(p==='/api/me'&&method==='GET')return json(res,200,{user:user||null,whatsappPhone:user?notifications.contact(user.id):'',notificationSettings:{whatsappReady:notifications.ready},shop:user?.role==='owner'?one('SELECT * FROM shops WHERE owner_id=?',user.id):null});
 if(p==='/api/register'&&method==='POST'){limit(req.socket.remoteAddress);const b=await body(req);const name=text(b.name,2,80),email=text(b.email,5,160).toLowerCase(),password=text(b.password,8,128);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('E-mail inválido.');if(!['owner','client'].includes(b.role))fail('Perfil inválido.');if(b.terms!==true)fail('Aceite os termos para continuar.');if(one('SELECT id FROM users WHERE email=?',email))fail('Este e-mail já está cadastrado.');const shopData=b.role==='owner'?{name:text(b.shopName,2,80),city:text(b.city,2,80),address:text(b.address,5,200)}:null;const uid=id();db.exec('BEGIN IMMEDIATE');try{run('INSERT INTO users VALUES(?,?,?,?,?)',uid,name,email,hash(password),b.role);if(shopData)createShop(uid,shopData.name,shopData.city,shopData.address);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return login(res,uid);}
 if(p==='/api/login'&&method==='POST'){limit(req.socket.remoteAddress);const b=await body(req);const u=one('SELECT * FROM users WHERE email=?',text(b.email).toLowerCase());if(!u||!verify(text(b.password,1,128),u.password))fail('E-mail ou senha incorretos.',401);return login(res,u.id);}
 if(p==='/api/logout'&&method==='POST'){if(token)run('DELETE FROM sessions WHERE token=?',token);return json(res,200,{ok:true},{'Set-Cookie':'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});}
 if(p==='/api/shops'&&method==='GET')return json(res,200,all('SELECT s.id,s.name,s.city,s.address,s.description,s.lat,s.lng,s.image,s.demo,MIN(v.price) AS from_price,(SELECT COUNT(*) FROM professionals WHERE shop_id=s.id AND active=1) AS team_count FROM shops s LEFT JOIN services v ON v.shop_id=s.id AND v.active=1 GROUP BY s.id ORDER BY s.demo,s.name'));
 if(/^\/api\/shops\/[^/]+$/.test(p)&&method==='GET'){const sid=p.split('/')[3],shop=one('SELECT id,name,city,address,description,lat,lng,image,demo FROM shops WHERE id=?',sid);if(!shop)fail('Barbearia não encontrada.',404);return json(res,200,{shop,services:all('SELECT * FROM services WHERE shop_id=? AND active=1',sid),professionals:all('SELECT * FROM professionals WHERE shop_id=? AND active=1',sid),hours:all('SELECT * FROM hours WHERE shop_id=? ORDER BY weekday',sid)});}
 if(p==='/api/slots'&&method==='GET')return json(res,200,slots(url.searchParams.get('shop'),url.searchParams.get('professional'),url.searchParams.has('services')?url.searchParams.get('services').split(','):url.searchParams.get('service'),url.searchParams.get('day')));
 if(!user)fail('Entre na sua conta para continuar.',401);
 if(/^\/api\/appointments\/[^/]+\/notifications$/.test(p)&&method==='GET'){
  const a=one('SELECT * FROM appointments WHERE id=?',p.split('/')[3]);
  if(!a)fail('Agendamento n\u00e3o encontrado.',404);
  if(user.role==='owner'?shopOwned(user).id!==a.shop_id:a.client_id!==user.id)fail('Sem permiss\u00e3o.',403);
  return json(res,200,{ready:notifications.ready,messages:notifications.list(a.id)});
 }
 if(p==='/api/appointments'&&method==='GET'){const key=user.role==='owner'?shopOwned(user).id:user.id;return json(res,200,all(`SELECT a.*,u.name AS client_name,COALESCE((SELECT group_concat(name,' + ') FROM (SELECT name FROM appointment_services WHERE appointment_id=a.id ORDER BY position)),s.name) AS service_name,p.name AS professional_name,b.name AS shop_name,b.address FROM appointments a JOIN users u ON u.id=a.client_id JOIN services s ON s.id=a.service_id JOIN professionals p ON p.id=a.professional_id JOIN shops b ON b.id=a.shop_id WHERE ${user.role==='owner'?'a.shop_id':'a.client_id'}=? ORDER BY a.day DESC,a.time DESC`,key));}
 if(p==='/api/appointments'&&method==='POST'){if(user.role!=='client')fail('Use uma conta de cliente para agendar.',403);const b=await body(req),whatsappPhone=b.whatsapp?.consent===true?normalizeWhatsApp(b.whatsapp.phone):null;db.exec('BEGIN IMMEDIATE');try{if(!slots(b.shop,b.professional,b.services??b.service,b.day).includes(b.time))fail('Este horário não está disponível. Escolha outro.',409);const services=selectedServices(b.shop,b.services??b.service),aid=id(),price=services.reduce((sum,s)=>sum+s.price,0),duration=services.reduce((sum,s)=>sum+s.duration,0);run('INSERT INTO appointments(id,shop_id,client_id,service_id,professional_id,day,time,duration,price) VALUES(?,?,?,?,?,?,?,?,?)',aid,b.shop,user.id,services[0].id,b.professional,b.day,b.time,duration,price);services.forEach((s,position)=>run('INSERT INTO appointment_services VALUES(?,?,?,?,?,?)',aid,s.id,s.name,s.price,s.duration,position));if(whatsappPhone)notifications.enqueue(aid,whatsappPhone);db.exec('COMMIT');setImmediate(()=>notifications.processDue().catch(()=>console.error('Falha ao processar avisos do WhatsApp.')));return json(res,201,{id:aid});}catch(e){db.exec('ROLLBACK');throw e;}}
 if(/^\/api\/appointments\/[^/]+$/.test(p)&&method==='PATCH'){const a=one('SELECT * FROM appointments WHERE id=?',p.split('/')[3]);if(!a)fail('Agendamento não encontrado.',404);const b=await body(req);if(user.role==='client'){if(a.client_id!==user.id)fail('Sem permissão.',403);if(a.status!=='confirmed'||new Date(a.day+'T'+a.time+':00-03:00')<=new Date())fail('Este agendamento não pode ser cancelado.');if(b.action!=='cancel')fail('Ação não permitida.',403);}else if(shopOwned(user).id!==a.shop_id)fail('Sem permissão.',403);if(b.action==='cancel'){if(a.status!=='confirmed')fail('Somente reservas confirmadas podem ser canceladas.');run("UPDATE appointments SET status='cancelled' WHERE id=?",a.id);notifications.cancel(a.id);}else if(b.action==='complete'){if(a.status!=='confirmed')fail('Reserva não pode ser concluída.');run("UPDATE appointments SET status='completed' WHERE id=?",a.id);notifications.cancel(a.id);}else if(b.action==='paid'){if(a.status==='cancelled'||a.payment==='paid')fail('Pagamento não pode ser registrado.');run("UPDATE appointments SET payment='paid' WHERE id=?",a.id);}else fail('Ação inválida.');return json(res,200,{ok:true});}
 if(user.role==='owner'){const shop=shopOwned(user);
 if(p==='/api/expenses'&&method==='GET')return json(res,200,all('SELECT * FROM expenses WHERE shop_id=? ORDER BY day DESC',shop.id));
 if(p==='/api/expenses'&&method==='POST'){const b=await body(req);run('INSERT INTO expenses VALUES(?,?,?,?,?)',id(),shop.id,text(b.description,2,120),Math.round(number(b.amount,0.01,1000000)*100),dayValue(b.day));return json(res,201,{ok:true});}
 if(p==='/api/manage'&&method==='GET')return json(res,200,{shop,services:all('SELECT * FROM services WHERE shop_id=? AND active=1',shop.id),professionals:all('SELECT * FROM professionals WHERE shop_id=? AND active=1',shop.id),hours:all('SELECT * FROM hours WHERE shop_id=? ORDER BY weekday',shop.id)});
 if(p==='/api/services'&&method==='POST'){const b=await body(req),name=text(b.name,2,80),price=Math.round(number(b.price,1,10000)*100),duration=number(b.duration,15,240);if(!Number.isInteger(duration))fail('Duração inválida.');run('INSERT INTO services(id,shop_id,name,price,duration) VALUES(?,?,?,?,?)',id(),shop.id,name,price,duration);return json(res,201,{ok:true});}
 if(/^\/api\/services\/[^/]+$/.test(p)&&['PATCH','DELETE'].includes(method)){const sid=p.split('/')[3];if(!one('SELECT id FROM services WHERE id=? AND shop_id=?',sid,shop.id))fail('Serviço não encontrado.',404);if(method==='DELETE')run('UPDATE services SET active=0 WHERE id=? AND shop_id=?',sid,shop.id);else{const b=await body(req),duration=number(b.duration,15,240);if(!Number.isInteger(duration))fail('Duração inválida.');run('UPDATE services SET name=?,price=?,duration=? WHERE id=? AND shop_id=?',text(b.name,2,80),Math.round(number(b.price,1,10000)*100),duration,sid,shop.id);}return json(res,200,{ok:true});}
 if(p==='/api/professionals'&&method==='POST'){const b=await body(req);run('INSERT INTO professionals(id,shop_id,name) VALUES(?,?,?)',id(),shop.id,text(b.name,2,80));return json(res,201,{ok:true});}
 if(p==='/api/settings'&&method==='PUT'){const b=await body(req);run('UPDATE shops SET name=?,city=?,address=?,description=?,lat=?,lng=? WHERE id=?',text(b.name,2,80),text(b.city,2,80),text(b.address,5,200),text(b.description||'',0,500),b.lat===''||b.lat==null?null:number(b.lat,-90,90),b.lng===''||b.lng==null?null:number(b.lng,-180,180),shop.id);return json(res,200,{ok:true});}
 if(p==='/api/hours'&&method==='PUT'){const b=await body(req);if(!Array.isArray(b.hours)||b.hours.length!==7||new Set(b.hours.map(h=>h.weekday)).size!==7)fail('Informe os sete dias.');for(const h of b.hours){number(h.weekday,0,6);if(!Number.isInteger(h.weekday)||mins(h.start)>=mins(h.end))fail('O fechamento deve ser depois da abertura.');}db.exec('BEGIN');try{for(const h of b.hours)run('UPDATE hours SET start=?,end=?,closed=? WHERE shop_id=? AND weekday=?',h.start,h.end,h.closed?1:0,shop.id,h.weekday);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return json(res,200,{ok:true});}
 }
 fail('Rota não encontrada.',404);
}
const assets={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/theme.css':'theme.css','/theme.js':'theme.js','/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.svg'};
export const server=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https://images.unsplash.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");try{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);const filename=assets[url.pathname];if(!filename){res.writeHead(404);return res.end('Não encontrado');}res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[path.extname(filename)]});res.end(readFileSync(path.join(root,'public',filename)));}catch(e){if(!e.status)console.error(e);json(res,e.status||500,{error:e.status?e.message:'Não foi possível concluir. Tente novamente.'});}});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`SpaceBarber disponível em http://localhost:${server.address().port}`));

const notificationTimer=setInterval(()=>notifications.processDue().catch(()=>console.error('Falha ao processar avisos do WhatsApp.')),15000);
notificationTimer.unref();
server.on('close',()=>clearInterval(notificationTimer));
setImmediate(()=>notifications.processDue().catch(()=>console.error('Falha ao processar avisos do WhatsApp.')));
