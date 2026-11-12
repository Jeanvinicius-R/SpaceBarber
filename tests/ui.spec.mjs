import { test,expect } from '@playwright/test';


import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let child,base,temporary;
test.beforeAll(async()=>{temporary=mkdtempSync(path.join(tmpdir(),'barbeiro-ui-'));child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,WHATSAPP_ENABLED:'false',PORT:'0',DATABASE_PATH:path.join(temporary,'ui.sqlite')},stdio:['ignore','pipe','pipe']});base=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;const match=out.match(/http:\/\/localhost:\d+/);if(match)resolve(match[0]);});child.on('error',reject);setTimeout(()=>reject(new Error('Servidor não iniciou')),15000).unref();});});
test.afterAll(async()=>{if(child){child.kill();await new Promise(resolve=>child.once('exit',resolve));}rmSync(temporary,{recursive:true,force:true});});
for(const [label,width,height] of [['desktop',1440,1000],['celular',390,844]]){
 test(`tema claro e escuro mantém escolha e funciona no ${label}`,async({page})=>{
  await page.setViewportSize({width,height});
  await page.emulateMedia({colorScheme:'dark'});
  await page.goto(base);
  await expect(page.getByRole('button',{name:'Ativar tema escuro'})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.getByRole('button',{name:'Ativar tema escuro'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 14, 12)');
  await page.reload();
  await expect(page.getByRole('button',{name:'Ativar tema claro'})).toBeVisible();
  await page.screenshot({path:`test-results/tema-escuro-${label}.png`,fullPage:true});
  await page.getByRole('button',{name:'Entrar',exact:true}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(27, 23, 19)');
  await page.getByRole('button',{name:'Testar como barbearia'}).click();
  await expect(page.getByRole('heading',{name:/Olá, Rafael/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Ativar tema claro'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/painel-escuro-${label}.png`,fullPage:true});
  await page.getByRole('button',{name:'Ativar tema claro'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.reload();
  await expect(page.getByRole('button',{name:'Ativar tema escuro'})).toBeVisible();
  expect(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe('rgb(247, 245, 241)');
 });
}
test('localização lista barbearias próximas e busca aceita cidade sem acentos',async({page,context})=>{await context.grantPermissions(['geolocation']);await context.setGeolocation({latitude:-23.555,longitude:-46.658});await page.goto(base);await page.getByRole('button',{name:'Perto de mim',exact:true}).click();await expect(page.locator('#results-count')).toContainText('em até 25 km');await expect(page.locator('.shop-card')).toHaveCount(3);await expect(page.locator('.shop-meta').first()).toContainText('km de você');await page.getByRole('button',{name:'Todas as barbearias',exact:true}).click();await page.locator('#city-search').fill('sao paulo');await expect(page.locator('.shop-card')).toHaveCount(3);});
test('cliente encontra barbearia, reserva e cancela seu horário',async({page})=>{const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});await page.goto(base);await expect(page.getByRole('heading',{name:'Seu próximo corte começa aqui.'})).toBeVisible();await expect(page.locator('.shop-card')).toHaveCount(3);await page.screenshot({path:'test-results/explorar-desktop.png',fullPage:true});await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.getByRole('button',{name:'Testar como cliente'}).click();await expect(page.locator('.profile')).toContainText('Gabriel');await page.locator('.shop-card').filter({hasText:'Studio Navalha'}).getByRole('button',{name:'Ver horários'}).click();await page.locator('#booking-day').fill('2030-01-07');await page.getByRole('button',{name:'10:00',exact:true}).click();await page.getByRole('button',{name:'Confirmar agendamento'}).click();await expect(page.getByRole('heading',{name:'Um horário reservado para você.'})).toBeVisible();await expect(page.locator('.booking-card')).toHaveCount(1);await expect(page.locator('.booking-card')).toContainText('Confirmado');await page.getByRole('button',{name:'Cancelar reserva'}).click();await page.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(page.locator('.booking-card')).toContainText('Cancelado');expect(errors).toEqual([]);});
test('gestão de serviços, despesas, configurações e navegação no celular',async({page})=>{const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});await page.goto(base);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.getByRole('button',{name:'Testar como barbearia'}).click();await expect(page.getByRole('heading',{name:/Olá, Rafael/})).toBeVisible();await page.screenshot({path:'test-results/painel-desktop.png',fullPage:true});await page.locator('.sidebar').getByRole('button',{name:'Serviços',exact:true}).click();await page.getByRole('button',{name:'Novo serviço'}).click();await page.getByLabel('Nome do serviço').fill('Corte teste navegador');await page.getByLabel('Valor em reais').fill('50');await page.getByRole('button',{name:'Salvar serviço'}).click();await expect(page.locator('.service-card').filter({hasText:'Corte teste navegador'})).toBeVisible();await page.locator('.sidebar').getByRole('button',{name:'Financeiro',exact:true}).click();await page.getByRole('button',{name:'Nova despesa'}).click();await page.getByLabel('Descrição').fill('Produtos de teste');await page.getByLabel('Valor em reais').fill('35.50');await page.getByRole('button',{name:'Registrar despesa'}).click();await expect(page.locator('.expense-grid')).toContainText('Produtos de teste');await expect(page.locator('.result-total')).toContainText('35,50');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/financeiro-celular.png',fullPage:true});await expect(page.locator('.mobile-nav')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.locator('.mobile-nav').getByRole('button',{name:'Gerenciar'}).click();await page.getByRole('dialog').getByRole('button',{name:'Horários',exact:true}).click();await expect(page.getByRole('heading',{name:'Horários de trabalho'})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Salvar horários'}).click();await expect(page.locator('#toast')).toContainText('Horários de trabalho salvos');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);});
test('busca, favoritos, cadastro e layout público no celular',async({page})=>{await page.setViewportSize({width:390,height:844});await page.goto(base);await expect(page.locator('.shop-card')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/explorar-celular.png',fullPage:true});await page.locator('#search').fill('Origem');await expect(page.locator('.shop-card')).toHaveCount(1);await page.getByRole('button',{name:'Adicionar aos favoritos'}).click();await page.locator('.mobile-nav').getByRole('button',{name:'Favoritos'}).click();await expect(page.locator('.shop-card')).toHaveCount(1);await page.getByRole('button',{name:'Criar conta',exact:true}).click();await page.getByLabel('Seu nome').fill('Novo Cliente');await page.getByLabel('E-mail',{exact:true}).fill('novo@browser.test');await page.getByLabel('Senha',{exact:true}).fill('Test@12345');await page.locator('[name=terms]').check();await page.getByRole('button',{name:'Criar minha conta',exact:true}).click();await expect(page.locator('.modal')).toHaveCount(0);await page.locator('.mobile-nav').getByRole('button',{name:'Meus agendamentos'}).click();await expect(page.getByRole('heading',{name:'Um horário reservado para você.'})).toBeVisible();});
test('proprietário cria sua barbearia independente e prepara o catálogo',async({page})=>{await page.goto(base);await page.getByRole('button',{name:'Criar conta',exact:true}).click();await page.getByRole('button',{name:'Tenho uma barbearia'}).click();await page.getByLabel('Seu nome').fill('Dona da Barbearia');await page.getByLabel('E-mail',{exact:true}).fill('owner-ui@browser.test');await page.getByLabel('Senha',{exact:true}).fill('Test@12345');await page.getByLabel('Nome da barbearia').fill('Barbearia Nova UI');await page.getByRole('dialog').getByLabel('Cidade',{exact:true}).fill('Campinas');await page.getByLabel('Endereço completo').fill('Rua das Flores, 123');await page.locator('[name=terms]').check();await page.getByRole('button',{name:'Criar minha conta',exact:true}).click();await expect(page.locator('.workspace')).toContainText('Barbearia Nova UI');await page.locator('.sidebar').getByRole('button',{name:'Profissionais',exact:true}).click();await page.getByRole('button',{name:'Adicionar profissional'}).click();await page.getByLabel('Nome do profissional').fill('João');await page.getByRole('dialog').getByRole('button',{name:'Adicionar profissional'}).click();await expect(page.locator('.team-card')).toContainText('João');await page.locator('.sidebar').getByRole('button',{name:'Serviços',exact:true}).click();await expect(page.locator('.service-card')).toHaveCount(0);await page.getByRole('button',{name:'Novo serviço'}).click();await page.getByLabel('Nome do serviço').fill('Corte degradê');await page.getByLabel('Valor em reais').fill('65');await page.getByRole('button',{name:'Salvar serviço'}).click();await expect(page.locator('.service-card')).toHaveCount(1);await page.locator('.sidebar').getByRole('button',{name:'Minha barbearia',exact:true}).click();await page.getByLabel('Sobre a barbearia').fill('Atendimento com cuidado e personalidade.');await page.getByRole('button',{name:'Salvar informações'}).click();await expect(page.locator('#toast')).toContainText('Informações atualizadas');});

test('cliente seleciona cabelo e barba em uma reserva no celular',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto(base);
 await page.getByRole('button',{name:'Entrar',exact:true}).first().click();await page.getByRole('button',{name:'Testar como cliente'}).click();
 await page.locator('.shop-card').filter({hasText:'Studio Navalha'}).getByRole('button',{name:'Ver horários'}).click();
 const haircut=page.locator('.service-choice').filter({hasText:'Corte masculino'}).getByRole('checkbox');
 const beard=page.locator('.service-choice').filter({hasText:'Barba & toalha quente'}).getByRole('checkbox');
 await haircut.uncheck();await expect(page.locator('#slots')).toContainText('Selecione pelo menos um serviço');
 await expect(page.getByRole('button',{name:'Confirmar agendamento'})).toBeDisabled();
 await haircut.check();await beard.check();await page.locator('#booking-day').fill('2030-01-09');
 await expect(page.locator('#booking-summary')).toContainText('80,00');await expect(page.locator('#booking-summary')).toContainText('60 min');
 await expect(page.getByRole('button',{name:'18:00',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'18:30',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'10:00',exact:true}).click();await beard.uncheck();
 await expect(page.locator('#booking-summary')).toContainText('45,00');await expect(page.locator('#booking-summary')).toContainText('30 min');
 await expect(page.locator('#booking-summary')).toContainText('Escolha um horário');
 await beard.check();await page.getByRole('button',{name:'11:00',exact:true}).click();await page.screenshot({path:'test-results/multiplos-servicos-celular.png',fullPage:true});await page.getByRole('button',{name:'Confirmar agendamento'}).click();
 await expect(page.locator('.booking-card').filter({hasText:'Corte masculino + Barba & toalha quente'})).toContainText('80,00');
 await page.locator('.mobile-nav').getByRole('button',{name:'Sair',exact:true}).click();
 await page.getByRole('button',{name:'Entrar',exact:true}).first().click();await page.getByRole('button',{name:'Testar como barbearia'}).click();
 await expect(page.locator('table')).toContainText('Corte masculino + Barba & toalha quente');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('cliente autoriza WhatsApp e acompanha os avisos sem simular envio real',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto(base);
 await page.getByRole('button',{name:'Entrar',exact:true}).first().click();await page.getByRole('button',{name:'Testar como cliente'}).click();
 await page.locator('.shop-card').filter({hasText:'Studio Navalha'}).getByRole('button',{name:'Ver horários'}).click();
 await page.locator('#booking-day').fill('2030-01-10');await page.getByRole('button',{name:'10:00',exact:true}).click();
 await expect(page.locator('.whatsapp-preferences')).toContainText('Envio pelo WhatsApp em preparação');
 await page.getByLabel('Seu WhatsApp com DDD').fill('(11) 99999-9999');await page.locator('[name=whatsappConsent]').check();
 const response=page.waitForResponse(r=>r.url().endsWith('/api/appointments')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Confirmar agendamento'}).click();const booking=await (await response).json();
 await page.locator(`[data-action="whatsapp-notices"][data-id="${booking.id}"]`).click();
 await expect(page.locator('.notification-item')).toHaveCount(2);await expect(page.getByRole('dialog')).toContainText('Aguardando ativação do WhatsApp');
 await page.getByText('Ver mensagem preparada',{exact:true}).first().click();await expect(page.locator('.notification-item pre').first()).toContainText('Corte masculino');
 await expect(page.locator('.notification-item pre').first()).toContainText('10/01/2030');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/avisos-whatsapp-celular.png',fullPage:true});
});
