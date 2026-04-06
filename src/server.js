require('dotenv').config();
const express=require('express'),cors=require('cors'),helmet=require('helmet'),rateLimit=require('express-rate-limit');
const app=express(),PORT=process.env.PORT||5000,isProd=process.env.NODE_ENV==='production';

app.use(helmet({crossOriginEmbedderPolicy:false,contentSecurityPolicy:false}));

const allowedOrigins=[process.env.FRONTEND_URL,'http://localhost:5173','http://localhost:4173','http://127.0.0.1:5173'].filter(Boolean);
app.use(cors({
  origin:(origin,cb)=>{
    if(!origin)return cb(null,true);
    if(allowedOrigins.includes(origin))return cb(null,true);
    if(!isProd)return cb(null,true);
    if(/\.vercel\.app$/.test(origin))return cb(null,true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials:true,methods:['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders:['Content-Type','Authorization'],
}));
app.use(express.json({limit:'5mb'}));
app.use(express.urlencoded({extended:true}));
app.set('trust proxy',1);

app.use('/api/',rateLimit({windowMs:60_000,max:300,standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests.'}}));
app.use('/api/auth/login',rateLimit({windowMs:15*60_000,max:20,message:{error:'Too many login attempts.'}}));
app.use('/api/tuma/stk-push',rateLimit({windowMs:60_000,max:15,message:{error:'Too many payment requests.'}}));

const db=require('./db/connection');
if(process.env.NODE_ENV!=='production'||process.env.ENABLE_BACKUP==='true'){
  try{require('../scripts/backup');}catch(e){console.warn('[BACKUP]',e.message);}
}

app.get('/ping',(_,res)=>res.json({ok:true,t:Date.now()}));
app.get('/health',(_,res)=>res.json({status:'ok',service:'Permic Wear API',payment:'tuma',time:new Date().toISOString()}));
app.get('/',(_,res)=>res.json({service:'Permic Wear API',status:'running'}));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/sales',     require('./routes/sales'));
app.use('/api/tuma',      require('./routes/tuma'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/logs',      require('./routes/logs'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/categories',require('./routes/categories'));
app.use('/api/stores',    require('./routes/stores'));
app.use('/api/returns',   require('./routes/returns'));
app.use('/api/barcodes',  require('./routes/barcodes'));

app.use((req,res)=>res.status(404).json({error:`Not found: ${req.method} ${req.path}`}));
app.use((err,_,res,__)=>{
  console.error('[ERROR]',err.message);
  if(err.message?.startsWith('CORS'))return res.status(403).json({error:err.message});
  res.status(500).json({error:'Internal server error'});
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🚀 Permic Wear API v6  Port:${PORT}  Mode:${process.env.NODE_ENV||'dev'}  Payment:Tuma\n`);
});
module.exports=app;
