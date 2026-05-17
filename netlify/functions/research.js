require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY) || 2;
const limit = pLimit(MAX_CONCURRENCY);

// Official Labour Rate Benchmarks
const LABOUR_RATES = {
  'Artisan Electrician': { rate: 245, unit: 'hr', authority: 'MBSA / SETA Bargaining Council' },
  'Artisan Plumber': { rate: 235, unit: 'hr', authority: 'BIBC / CETA Benchmark' },
  'Semi-Skilled Labourer': { rate: 45, unit: 'hr', authority: 'Dept of Employment & Labour Sec Det 13' },
  'Site Supervisor': { rate: 320, unit: 'hr', authority: 'MBSA / NEC Contract Schedule' }
};

function generateQuery(desc) {
  return desc.replace(/supply\s*and\s*deliver|remove\s*and\s*install|install|complete|or\s+equivalent|or\s+equivelant/gi, '')
             .replace(/\(.*?\)/g, '').trim() + ' price South Africa site:*.co.za';
}

async function searchSuppliers(query) {
  try {
    const res = await axios.post('https://google.serper.dev/search', {
      q: query, gl: 'za', hl: 'en', num: 8
    }, { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' } });
    return (res.data.organic || []).slice(0, 5).map(r => ({ title: r.title, url: r.link }));
  } catch { return []; }
}

async function extractPrice(url) {
  try {
    const res = await axios.get('https://api.scraperapi.com/', { params: { api_key: SCRAPER_API_KEY, url, render: true } });
    const $ = cheerio.load(res.data);
    let price = null;
    
    // Attempt 1: Structured Data (JSON-LD)
    const ld = $('script[type="application/ld+json"]').html();
    if(ld) { try { const d=JSON.parse(ld); if(d.offers?.price) price=d.offers.price; } catch{} }
    
    // Attempt 2: Open Graph
    if(!price) { const og=$('meta[property="product:price:amount"]').attr('content'); if(og) price=parseFloat(og); }
    
    // Attempt 3: Simple Regex Scan
    if(!price) { const b=$('body').text().replace(/\s+/g,' '); const m=b.match(/R\s?(\d{1,6}[.,]?\d{0,2})/); if(m) price=parseFloat(m[1].replace(',','.')); }

    return { price: price || null, date: new Date() };
  } catch { return { price: null, date: new Date() }; }
}

exports.handler = async(event) => {
  if(event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body; try { body=JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  
  const { items } = body;
  if(!items || !Array.isArray(items)) return { statusCode: 400, body: 'Missing items' };

  try {
    console.log(`🔍 Processing ${items.length} items...`);
    
    const results = await Promise.all(items.map(async(item) => {
      if(item.isLabour) {
        const trade = Object.keys(LABOUR_RATES).find(k => item.desc.toLowerCase().includes(k.toLowerCase())) || 'Semi-Skilled Labourer';
        const info = LABOUR_RATES[trade];
        return { ...item, unitRate: info.rate, total: info.rate * item.qty, trade: trade, source: info.authority };
      }
      
      const urls = await searchSuppliers(generateQuery(item.description));
      if(urls.length === 0) return { ...item, unitRate: 0, total: 0, supplier: 'N/A' };
      
      const prices = await Promise.all(urls.map(u => extractPrice(u.url)));
      const valid = prices.filter(p => p.price).sort((a,b)=>a.price-b.price);
      
      if(valid.length === 0) return { ...item, unitRate: 0, total: 0, supplier: 'Unresolved' };
      
      return { ...item, unitRate: valid[0].price, total: valid[0].price * item.qty, supplier: valid[0].url.split('/')[2] };
    }));

    return { statusCode: 200, body: JSON.stringify({ success:true, materials: results.filter(i=>!i.isLabour), labour: results.filter(i=>i.isLabour) }) };
  } catch(e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};