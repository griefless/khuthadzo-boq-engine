require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY) || 2;
const limit = pLimit(MAX_CONCURRENCY);

const CATEGORY_SUPPLIERS = {
  'Electrical': ['mce.co.za', 'acdc.co.za', 'arbelectrical.co.za', 'voltex.co.za', 'rexel.co.za', 'legrand.co.za', 'se.com/za'],
  'Plumbing & Drainage': ['plumblink.co.za', 'builders.co.za', 'marleypipe.co.za', 'macneil.co.za', 'capedrainage.co.za'],
  'Civil & Construction': ['builders.co.za', 'ppc.africa', 'afrisam.co.za', 'cashbuild.co.za', 'buildit.co.za'],
  'Fencing & Security': ['betafence.co.za', 'safence.co.za', 'cohrane.co.za', 'wireproducts.co.za'],
  'Health & Medical': ['medhold.co.za', '4sammedical.co.za', 'citymedical.co.za', 'dischembusiness.co.za'],
  'Electronics & ICT': ['rectron.co.za', 'pinnacle.co.za', 'mustek.co.za', 'takealot.com', 'wootware.co.za'],
  'General & PPE': ['builders.co.za', 'makro.co.za', 'safetyfirst.co.za', 'healthandsafetyshopping.co.za'],
  'Mechanical & HVAC': ['carrier.com', 'daikin.co.za', 'refrigwarehouse.co.za', 'puma.co.za']
};

const LABOUR_RATES = {
  'Artisan Electrician': { rate: 245, unit: 'hr', authority: 'MBSA / SETA Bargaining Council' },
  'Artisan Plumber': { rate: 235, unit: 'hr', authority: 'BIBC / CETA Benchmark' },
  'Artisan Carpenter': { rate: 220, unit: 'hr', authority: 'JBCC / CETA Benchmark' },
  'Artisan Tiler': { rate: 215, unit: 'hr', authority: 'BIBC Benchmark' },
  'Artisan Welder': { rate: 240, unit: 'hr', authority: 'BIBC Benchmark' },
  'Semi-Skilled Labourer': { rate: 45, unit: 'hr', authority: 'Dept of Employment & Labour Sec Det 13' },
  'Security Guard': { rate: 42, unit: 'hr', authority: 'PSIRA Grade A / Sectoral Determination' },
  'Project Engineer': { rate: 450, unit: 'hr', authority: 'ECSA Professional Benchmark' },
  'Site Supervisor': { rate: 320, unit: 'hr', authority: 'MBSA / NEC Contract Schedule' },
  'General Plant Operator': { rate: 185, unit: 'hr', authority: 'CETA Machinery Operators Benchmark' }
};

function generateQuery(desc) {
  return desc.replace(/supply\s*and\s*deliver|remove\s*and\s*install|install|complete|or\s+equivalent|or\s+equivelant/gi, '')
             .replace(/\(.*?\)/g, '').trim() + ' price South Africa site:*.co.za';
}

async function searchSuppliers(query) {
  try {
    const res = await axios.post('https://google.serper.dev/search', {
      q: query, gl: 'za', hl: 'en', num: 10
    }, { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' } });
    
    return (res.data.organic || [])
      .filter(r => r.link && r.link.includes('.co.za') && !r.link.match(/facebook|twitter|linkedin|youtube|news24|iol|gumtree|bidorbuy|takealot/))
      .slice(0, 8);
  } catch { return []; }
}

async function extractPrice(url, metaDesc) {
  try {
    const res = await axios.get('https://api.scraperapi.com/', { 
      params: { api_key: SCRAPER_API_KEY, url, render: true } 
    });
    const html = res.data;
    if(!html) return { price: null, inStock: false, notes: 'Unresolved (Bot Blocked)', date: new Date() };
    
    const $ = cheerio.load(html);
    let price = null, stock = false;
    const now = new Date();

    const ld = $('script[type="application/ld+json"]').html();
    if(ld) { 
      try { 
        const d=JSON.parse(ld); 
        const o=d.offers||d?.aggregateOffer?.offers||[]; 
        const of=Array.isArray(o)?o[0]:o; 
        if(of?.price) price=parseFloat(of.price); 
        if(of?.availability?.includes('InStock')) stock=true; 
        if(d.datePublished) { const pub=new Date(d.datePublished); if(now - pub > 30*24*60*60*1000) return { price, inStock: stock, notes: '⚠ PRICE MAY BE OUTDATED (>30 Days)', date: pub }; } 
      } catch{} 
    }

    if(!price) { const og=$('meta[property="product:price:amount"]').attr('content'); if(og) price=parseFloat(og); }
    if(!price) { const el=$('.price,.product-price,[data-price],span:contains("R")').first().text(); const m=el.match(/R\s?(\d{1,6}[.,]?\d{0,2})/); if(m) price=parseFloat(m[1].replace(',','.')); }
    if(!price) { const b=$('body').text().replace(/\s+/g,' '), ms=[...b.matchAll(/R\s?(\d{1,6}[.,]?\d{0,2})/g)]; if(ms.length>0) { const nums=ms.map(x=>parseFloat(x[1].replace(',','.'))).filter(n=>n>5&&n<500000); if(nums.length>0) price=Math.min(...nums); } }

    if(!stock) { const t=$('body').text().toLowerCase(); stock=(t.includes('in stock')||t.includes('add to cart')||t.includes('available'))&&!t.includes('out of stock'); }

    let note='';
    if(metaDesc.toUpperCase().match(/SAN[S]?[\s]?[\d]{4}/)){ note+=' ⚠ SABS/SANS STANDARD REQUIRED '; }
    if(!stock) note+= ' Stock unconfirmed';

    return { price, inStock: stock, notes: note.trim() || (stock?'✓ Confirmed':'⚠ Limited Data'), date: now };
  } catch(e) { return { price: null, inStock: false, notes: 'Fetch Failed', date: new Date() }; }
}

exports.handler = async(event) => {
  if(event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body; try { body=JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  
  const { items } = body;
  if(!items || !Array.isArray(items)) return { statusCode: 400, body: 'Missing items' };

  try {
    console.log(`🔍 Processing ${items.length} items via V4 Spec Pipeline...`);
    
    const results = await Promise.all(items.map(async(item) => {
      let supUrls = await searchSuppliers(generateQuery(item.description));
      
      if(supUrls.length === 0) return { ...item, unitRate: 0, total: 0, supplier: '—', url: '#', notes: '🔴 NO SOURCES FOUND (<3 URLs)', allSuppliers: [] };

      const extracted = await Promise.all(supUrls.map(u => limit(() => extractPrice(u, item.description))));
      const valid = extracted.filter(r => r.price && r.price > 0).sort((a,b)=>a.price-b.price).slice(0, 5);

      if(valid.length === 0) return { ...item, unitRate: 0, total: 0, supplier: '—', url: '#', notes: '⚠ Prices Unresolvable (POA/Login)', allSuppliers: [] };

      const best = valid[0];
      return {
        ...item,
        unitRate: best.price,
        total: best.price * item.qty,
        supplier: best.url.split('/')[2]?.replace('www.','') || 'Unknown',
        url: best.url,
        inStock: best.inStock,
        notes: best.notes,
        allSuppliers: valid.map((v,i) => ({ rank: i+1, supplier: v.url.split('/')[2], url: v.url, price: v.price, inStock: v.inStock, date: v.date.toISOString().split('T')[0] }))
      };
    }));

    const labourResults = items.filter(i=>i.isLabour).map(i => {
      const tradeKey = Object.keys(LABOUR_RATES).find(k => i.description.toLowerCase().includes(k.toLowerCase())) || 'Artisan Electrician';
      const info = LABOUR_RATES[tradeKey];
      return {
        ...i, trade: tradeKey, rate: info.rate, source: info.authority,
        total: info.rate * i.qty, flag: '⚠ GUIDELINE ESTIMATE — Verify against Current Bargaining Council Agreement'
      };
    });

    return { statusCode: 200, body: JSON.stringify({ success:true, materials:results, labour:labourResults, timestamp: new Date().toISOString() }) };
  } catch(e) { console.error(e); return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};