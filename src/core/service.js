import './env.js';
import { z } from 'zod';
import config from './config.js';
import { openStore } from './store.js';
import { sendMail } from './mail.js';
import { AppError, baseUrl, rateLimit } from './security.js';

const fieldSchema = field => {
  if (field.type === 'checkbox') return z.enum(['on','true'], {error:`${field.label} is required.`});
  let value=z.string().trim().min(1,`${field.label} is required.`).max(field.type==='textarea'?2000:300,`${field.label} is too long.`);
  if(field.type==='email') value=value.email('Enter a valid email address.').transform(s=>s.toLowerCase());
  if(field.type==='url') value=value.refine(s=>{try{return ['https:','http:'].includes(new URL(s).protocol)}catch{return false}},'Enter an HTTP or HTTPS URL.');
  if(field.type==='datetime-local') value=value.refine(s=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && Number.isFinite(Date.parse(s+'Z')) && new Date(s+'Z').toISOString().slice(0,16)===s, 'Enter a valid date and time.');
  if(field.options) value=value.refine(s=>field.options.some(option=>option.value===s),'Choose one of the listed options.');
  return value;
};
export const submissionSchema=z.object(Object.fromEntries(config.fields.map(f=>[f.name,fieldSchema(f)])));
export const jsonSchema={type:'object',required:config.fields.map(f=>f.name),properties:Object.fromEntries(config.fields.map(f=>[f.name,{type:'string',minLength:1,maxLength:f.type==='textarea'?2000:300,...(f.options?{enum:f.options.map(o=>o.value)}:{})}]))};

export function createService({store=openStore(), deliver=sendMail}={}) {
  const {db,records,get,find,insert,update,atomic,token,inspectToken,consume,queue}=store;
  const owner=()=>process.env.OWNER_EMAIL || 'owner@example.com';
  const link=raw=>`${baseUrl()}/access/${raw}`;
  const notify=(row,key,to,subject,text,replyTo)=>queue(`${row.id}:${key}`,{to:Array.isArray(to)?to:[to],subject,text,category:`${config.kind}.${key.split('-')[0]}`,customVariables:{record_id:row.id,workflow:config.kind},headers:{'X-Workflow-Reference':row.id},...(replyTo?{replyTo}:{})});
  const duplicate=(key,message='This request has already been recorded.')=>{if(find(key))throw new AppError(message,409)};
  const requirePending=(id,status='pending')=>{const row=get(id);if(!row || row.kind!==config.kind)throw new AppError('Record not found.',404);if(row.status!==status)throw new AppError('This record has already been updated.',409);return row};
  if(!records('bookmark').length)atomic(()=>{insert('bookmark',{title:'MDN Web Docs',url:'https://developer.mozilla.org/'},'saved');insert('bookmark',{title:'The web platform',url:'https://web.dev/'},'saved')});
const onSubmit=data=>{const row=insert(config.kind,data,'shared');const raw=token(row.id,'view',604800);notify(row,'share',data.email,'A reading collection for you',`Hello ${data.name},\nHere is a small collection of useful bookmarks:\n${link(raw)}\nThis private link expires in seven days.`);return row};
const onAction=({action,title,url})=>{if(action!=='add_bookmark')throw new AppError('Unknown action.');const parsed=z.object({title:z.string().trim().min(1).max(120),url:z.string().url().refine(v=>['https:','http:'].includes(new URL(v).protocol))}).safeParse({title,url});if(!parsed.success)throw new AppError('Enter a title and a valid HTTP(S) URL.');insert('bookmark',parsed.data,'saved');return {ok:true,message:'Bookmark saved.'}};
const publicView=()=>({count:records('bookmark').length,rows:records('bookmark').map(r=>({title:r.data.title,description:r.data.url}))});
const adminExtra=()=>({bookmarks:records('bookmark').map(r=>r.data)});
const accessDescription=grant=>JSON.stringify(records('bookmark').map(r=>r.data));
  const onRedeem=()=>{throw new AppError('Unknown link action.',400)};
  let flushing=false;
  async function flush() {
    if(flushing)return; flushing=true;
    const save=(id,result)=>db.prepare('UPDATE outbox SET status=?,provider_id=?,error=? WHERE id=?').run(result.status,result.providerId || '',result.error || null,id);
    try {
      while(true) {
        const candidates=db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 20").all();
        if(!candidates.length)break;
        const claimed=[];
        for(const row of candidates) {
          const message=JSON.parse(row.payload);
          if(message.subscriberId && get(message.subscriberId)?.status!=='confirmed') {
            db.prepare("UPDATE outbox SET status='cancelled' WHERE id=? AND status='pending'").run(row.id);continue;
          }
          if(db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(row.id).changes)claimed.push({...row,message});
        }
        for(const row of claimed) {
          try {const result=await deliver(row.message); if(!['accepted','logged'].includes(result?.status))throw Object.assign(new Error('Unrecognized send result.'),{uncertain:true});save(row.id,result);}
          catch(error){save(row.id,{status:error.uncertain?'unknown':'failed',error:error.message || 'Sending failed.'});}
        }
      }
    } finally {flushing=false;}
  }
  async function submit(input, identity='local') {
    const parsed=submissionSchema.safeParse(input);
    if(!parsed.success)throw new AppError(parsed.error.issues[0].message);
    const data=parsed.data;
    rateLimit(db,`ip:${identity}`);
    if(data.email)rateLimit(db,`recipient:${data.email}`,3);
    if(data.second_email)rateLimit(db,`recipient:${data.second_email}`,3);
    const result=atomic(()=>onSubmit(data));
    await flush();
    let message=result.message || config.success;
    if(result.id){
      const states=db.prepare('SELECT status FROM outbox WHERE dedupe_key LIKE ?').all(`${result.id}:%`).map(row=>row.status);
      if(states.some(state=>['failed','unknown','pending','sending'].includes(state)))message+=' The email has not been confirmed as sent yet; the operator can review its status.';
      else if(states.includes('logged'))message+=' The email was recorded locally; no message was sent.';
    }
    return {ok:true,message,id:result.id || null};
  }
  async function action(input) {
    const result=atomic(()=>onAction(input));await flush();return result;
  }
  function access(raw) {
    const grant=inspectToken(raw);
    if(!grant || !grant.record)throw new AppError('This link is invalid, expired, or already used.',410);
    return {action:grant.action, title:config.title, token:raw, description:accessDescription(grant), recordId:grant.record_id};
  }
  async function redeem(raw, decision) {
    const result=atomic(()=>{
      const grant=inspectToken(raw);
      if(!grant || !grant.record)throw new AppError('This link is invalid, expired, or already used.',410);
      const value=onRedeem(grant,decision);consume(raw);return value;
    });
    await flush();return result;
  }
  function adminView() {return {records:records(config.kind),outbox:db.prepare('SELECT id,status,error,created_at FROM outbox ORDER BY created_at DESC LIMIT 30').all(),extra:adminExtra()};}
  function retryFailed() {db.prepare("UPDATE outbox SET status='pending',error=NULL WHERE status='failed'").run();return flush();}
  return {store,submit,action,access,redeem,publicView,adminView,flush,retryFailed};
}
let singleton;
export function service() {return singleton ||= createService();}
