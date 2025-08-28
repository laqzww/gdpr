#!/usr/bin/env node

const axios = require('axios');
const cheerio = require('cheerio');

// Function to extract title from __NEXT_DATA__
function extractTitleFromNextData(html, hearingId) {
    try {
        const $ = cheerio.load(html);
        const nextDataEl = $('script#__NEXT_DATA__');
        if (!nextDataEl.length) {
            console.log(`  [${hearingId}] No __NEXT_DATA__ found`);
            return null;
        }
        
        const jsonData = JSON.parse(nextDataEl.text());
        const queries = jsonData?.props?.pageProps?.dehydratedState?.queries || [];
        
        console.log(`  [${hearingId}] Found ${queries.length} queries`);
        
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;
            
            const included = Array.isArray(root?.included) ? root.included : [];
            const contents = included.filter(x => x?.type === 'content');
            
            console.log(`  [${hearingId}] Found ${contents.length} content items`);
            
            // Look for content with field ID 1 (title)
            const titleContent = contents.find(c => 
                String(c?.relationships?.field?.data?.id || '') === '1' && 
                c?.attributes?.textContent
            );
            
            if (titleContent) {
                console.log(`  [${hearingId}] Found title in field ID 1`);
                return String(titleContent.attributes.textContent).trim();
            }
            
            // Debug: show all content fields
            contents.forEach(c => {
                const fieldId = c?.relationships?.field?.data?.id;
                const text = c?.attributes?.textContent;
                if (fieldId && text) {
                    console.log(`  [${hearingId}] Field ${fieldId}: "${text.substring(0, 50)}..."`);
                }
            });
        }
        
        return null;
    } catch (e) {
        console.error(`  [${hearingId}] Error parsing:`, e.message);
        return null;
    }
}

async function fetchHearingTitle(id) {
    try {
        console.log(`\nFetching hearing ${id}...`);
        const url = `https://blivhoert.kk.dk/hearing/${id}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8'
            },
            timeout: 15000,
            maxRedirects: 5
        });
        
        console.log(`  [${id}] Response status: ${response.status}`);
        
        if (response.status === 200 && response.data) {
            // Check if we got a real hearing page
            if (response.data.includes('hearing') || response.data.includes('__NEXT_DATA__')) {
                const title = extractTitleFromNextData(response.data, id);
                return title || `Høring ${id}`;
            } else {
                console.log(`  [${id}] No hearing content found in response`);
                return `Høring ${id}`;
            }
        }
        
        return `Høring ${id}`;
    } catch (e) {
        if (e.response) {
            console.error(`  [${id}] HTTP Error ${e.response.status}: ${e.response.statusText}`);
        } else {
            console.error(`  [${id}] Error:`, e.message);
        }
        return `Høring ${id}`;
    }
}

async function main() {
    const hearingIds = [107, 167, 168, 190, 192];
    
    console.log('Henter titler for høringer med debug info...\n');
    
    const results = [];
    for (const id of hearingIds) {
        const title = await fetchHearingTitle(id);
        results.push({ id, title });
    }
    
    console.log('\n\nResultater:');
    console.log('============');
    for (const { id, title } of results) {
        console.log(`Høring ${id}: ${title}`);
    }
}

main().catch(console.error);