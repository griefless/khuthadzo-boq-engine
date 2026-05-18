require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');

// 🔑 API Keys Integrated
const SERPER_API_KEY = process.env.SERPER_API_KEY || '2fa57c908e7dfa609d96de587555000f78cf19fc';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '31aeb09ca552be7ed6cbcd83b26112dd';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY) || 3;
const limit = pLimit(MAX_CONCURRENCY);

const LABOUR_RATES = {
  'Electrician': { rate: 245, unit: 'hr', authority: 'MBSA / ECA Bargaining Council' },
  'Plumber': { rate: 235, unit: 'hr', authority: 'PIBC / CETA Benchmark' },
  'Tiler': { rate: 180, unit: 'hr', authority: 'MBSA / BIBC' },
  'Painter': { rate: 160, unit: 'hr', authority: 'MBSA / BIBC' },
  'Bricklayer': { rate: 190, unit: 'hr', authority: 'MBSA / BIBC' },
  'Carpenter': { rate: 200, unit: 'hr', authority: 'MBSA / BIBC' },
  'Welder': { rate: 220, unit: 'hr', authority: 'SEIFSA / MBSA' },
  'General Labourer': { rate: 45, unit: 'hr', authority: 'Dept of Employment & Labour Sec Det 13' },
  'Site Supervisor': { rate: 320, unit: 'hr', authority: 'MBSA / NEC Contract Schedule' },
  'Security Guard': { rate: 55, unit: 'hr', authority: 'PSIRA / SBCA' }
};

const SUPPLIER_PRIORITY = {
  'Plumbing': ['plumblink.co.za', 'builders.co.za', 'marleypipesystems.co.za', 'macneil.co.za', 'capedrainage.co.za'],
  'Electrical': ['mceelectric.co.za', 'acdc.co.za', 'arb.co.za', 'voltex.co.za', 'rexel.co.za', 'legrand.co.za', 'schneider-electric.co.za'],
  'Civil': ['builders.co.za', 'ppc.co.za', 'afrisam.com', 'cashbuild.co.za', 'buildit.co.za'],
  'Fencing': ['betafence.co.za', 'safenceandgate.co.za', 'cochranesteel.co.za', 'wireproducts.co.za'],
  'Health': ['medhold.co.za', '4sa.co.za', 'medimore.co.za', 'citymedical.co.za', 'dischem.co.za'],
  'ICT': ['rectron.co.za', 'pinnacle.co.za', 'mustek.co.za', 'takealot.com', 'wootware.co.za'],
  'General': ['builders.co.za', 'makro.co.za', 'safetyfirstsa.co.za'],
  'HVAC': ['carrier.co.za', 'daikin.co.za', 'refrigerationwarehouse.co.za', 'pumpandabrasion.co.za']
};

function detectCategory(desc) {
  const d = desc.toLowerCase();
  if (/pipe|fitting|valve|drain|tap|toilet|basin|plumb/gi.test(d)) return 'Plumbing';
  if (/cable|wire|switch|socket|db|breaker|light|led|electrical|lv/gi.test(d)) return 'Electrical';
  if (/cement|concrete|brick|sand|stone|civil|excavat/gi.test(d)) return 'Civil';
  if (/fence|gate|security|camera|cctv|alarm|access control/gi.test(d)) return 'Fencing';
  if (/medical|glove|mask|syringe|bandage|health|ppe|safety/gi.test(d)) return 'Health';
  if (/computer|laptop|server|switch|router|cctv|ict|electronic|toner|printer/gi.test(d)) return 'ICT';
  if (/hvac|air con|duct|fan|pump|compressor|mechanical/gi.test(d)) return 'HVAC';
  return 'General';
}

function generateQuery(desc) {
  const safeDesc = (desc || '').toString();
  const clean = safeDesc.replace(/supply\sand\sdeliver|remove\sand\sinstall|install|complete|or\s+equivalent|provisional|pc\sitem/gi, '')
    .replace(/[^\w\s\d\.\-\/]/g, ' ').trim();
  return `${clean} price South Africa site:.co.za`;
}

async function searchSuppliers(query, category) {
  try {
    const res = await axios.post('https://google.serper.dev/search', {
      q: query, gl: 'za', hl: 'en', num: 10
    }, { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' } });
    
    let urls = (res.data.organic || []).map(r => r.link);
    const priority = SUPPLIER_PRIORITY[category] || [];
    
    urls.sort((a, b) => {
      const aP = priority.findIndex(p => a.includes(p));
      const bP = priority.findIndex(p => b.includes(p));
      if (aP !== -1 && bP === -1) return -1;
      if (bP !== -1 && aP === -1) return 1;
      if (aP !== -1 && bP !== -1) return aP - bP;
      return 0;
    });
    
    return urls.slice(0, 7).map(url => ({ url }));
  } catch (e) {
    return [];
  }
}

async function extractPrice(url) {
  try {
    const res = await axios.get('https://api.scraperapi.com/', { 
      params: { api_key: SCRAPER_API_KEY, url, render: true, keep_headers: true },
      timeout: 15000 
    });
    const $ = cheerio.load(res.data);
    let price = null, inStock = false;

    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const d = JSON.parse($(el).html());
        if (d.offers) {
          const offer = Array.isArray(d.offers) ? d.offers[0] : d.offers;
          if (offer.price) price = parseFloat(offer.price);
          if (offer.availability?.includes('InStock')) inStock = true;
        }
      } catch {}
    });

    if (!price) {
      const og = $('meta[property="product:price:amount"]').attr('content');
      if (og) price = parseFloat(og);
      if ($('meta[property="product:availability"]').attr('content')?.toLowerCase().includes('instock')) inStock = true;
    }

    if (!price) {
      const body = $('body').text().replace(/\s+/g, ' ');
      const m = body.match(/R\s?(\d{1,3}(?:[\s,]?\d{3})*(?:\.\d{1,2})?)/);
      if (m) price = parseFloat(m[1].replace(/[\s,]/g, ''));
      if (body.match(/in\sstock|add\s to\scart|buy\snow/i)) inStock = true;
    }

    return { price: price || null, inStock, url, date: new Date().toISOString() };
  } catch {
    return { price: null, inStock: false, url, date: new Date().toISOString() };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body; try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { items } = body;
  if (!items?.length) return { statusCode: 400, body: 'Missing items' };

  try {
    const results = await Promise.all(items.map(item => limit(async () => {
      const desc = (item.description || item.desc || '').toString();
      const isLabour = item.isLabour || /install|lay|fix|erect|excavat|demolish|paint|plaster|weld|connect|terminate|commission|test|hang|set|place|construct|provide|labour|fitting/gi.test(desc);
      const category = detectCategory(desc);
      
      if (isLabour) {
        const trade = Object.keys(LABOUR_RATES).find(k => desc.toLowerCase().includes(k.toLowerCase())) || 'General Labourer';
        const info = LABOUR_RATES[trade];
        return { ...item, isLabour: true, category, unitRate: info.rate, total: info.rate * (item.qty || 1), trade, source: info.authority, flag: 'Guideline Rate - Verify with Bargaining Council' };
      }
      
      const urls = await searchSuppliers(generateQuery(desc), category);
      if (!urls.length) return { ...item, isLabour: false, category, unitRate: 0, total: 0, supplier: 'N/A', flag: 'No suppliers found' };
      
      const prices = await Promise.all(urls.map(u => extractPrice(u.url)));
      const valid = prices.filter(p => p.price > 0).sort((a, b) => a.price - b.price);
      
      if (!valid.length) return { ...item, isLabour: false, category, unitRate: 0, total: 0, supplier: 'Unresolved', flag: 'NO PRICE FOUND', evidence: prices };
      
      const best = valid[0];
      return { ...item, isLabour: false, category, unitRate: best.price, total: best.price * (item.qty || 1), supplier: best.url.split('/')[2], supplierUrl: best.url, flag: best.inStock ? 'Confirmed Stock' : 'Unconfirmed Stock', evidence: valid.slice(0, 5) };
    })));

    return { statusCode: 200, body: JSON.stringify({ success: true, results }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};