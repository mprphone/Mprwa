const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qcdjofjodklytfxchxnt.supabase.co'; // (or read from .env)
const SUPABASE_KEY = process.env.SUPABASE_KEY;

require('dotenv').config();

const url = `${process.env.SUPABASE_URL}/rest/v1/pedidos?limit=1`;
fetch(url, {
  headers: {
    apikey: process.env.SUPABASE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_KEY}`
  }
}).then(r => r.json()).then(data => console.log(JSON.stringify(data, null, 2))).catch(console.error);
