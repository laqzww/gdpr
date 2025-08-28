#!/usr/bin/env node

const axios = require('axios');
const cheerio = require('cheerio');

// Function to extract title from __NEXT_DATA__
function extractTitleFromNextData(html) {
    try {
        const $ = cheerio.load(html);
        const nextDataEl = $('script#__NEXT_DATA__');
        if (!nextDataEl.length) return null;
        
        const jsonData = JSON.parse(nextDataEl.text());
        const queries = jsonData?.props?.pageProps?.dehydratedState?.queries || [];
        
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;
            
            const included = Array.isArray(root?.included) ? root.included : [];
            const contents = included.filter(x => x?.type === 'content');
            
            // Look for content with field ID 1 (title)
            const titleContent = contents.find(c => 
                String(c?.relationships?.field?.data?.id || '') === '1' && 
                c?.attributes?.textContent
            );
            
            if (titleContent) {
                return String(titleContent.attributes.textContent).trim();
            }
        }
        
        return null;
    } catch (e) {
        console.error('Error parsing:', e.message);
        return null;
    }
}

async function fetchHearingTitle(id) {
    try {
        const url = `https://blivhoert.kk.dk/hearing/${id}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml'
            },
            timeout: 10000
        });
        
        if (response.status === 200 && response.data) {
            const title = extractTitleFromNextData(response.data);
            return title || `Høring ${id}`;
        }
        
        return `Høring ${id}`;
    } catch (e) {
        console.error(`Error fetching hearing ${id}:`, e.message);
        return `Høring ${id}`;
    }
}

async function main() {
    const hearingIds = [107, 167, 168, 190, 192];
    
    console.log('Henter titler for høringer...\n');
    
    for (const id of hearingIds) {
        const title = await fetchHearingTitle(id);
        console.log(`Høring ${id}: ${title}`);
    }
}

main().catch(console.error);