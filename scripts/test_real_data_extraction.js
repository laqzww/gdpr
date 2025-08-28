#!/usr/bin/env node

// Test script to verify title extraction works with real data

const fs = require('fs');
const path = require('path');

// Real data structure from the API (extracted from hearing 107)
const realNextData = {
    "props": {
        "pageProps": {
            "dehydratedState": {
                "queries": [{
                    "state": {
                        "data": {
                            "data": {
                                "data": {
                                    "id": "107",
                                    "type": "hearing",
                                    "attributes": {
                                        "deadline": "2025-01-10T00:00:00Z",
                                        "startDate": "2024-11-15T00:00:00Z"
                                    },
                                    "relationships": {
                                        "hearingStatus": {
                                            "data": {"id": "5", "type": "hearingStatus"}
                                        },
                                        "contents": {
                                            "data": [
                                                {"id": "484", "type": "content"}
                                            ]
                                        }
                                    }
                                },
                                "included": [
                                    {
                                        "id": "5",
                                        "type": "hearingStatus",
                                        "attributes": {
                                            "name": "Afventer konklusion"
                                        }
                                    },
                                    {
                                        "id": "484",
                                        "type": "content",
                                        "attributes": {
                                            "textContent": "Nordre Fasanvej Nord - forslag til lokalplan"
                                        },
                                        "relationships": {
                                            "field": {
                                                "data": {"id": "1", "type": "field"}
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }]
            }
        }
    }
};

// Import the functions
function fixEncoding(s) {
    return String(s || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractMetaFromNextJson(jsonRoot) {
    try {
        const queries = jsonRoot?.props?.pageProps?.dehydratedState?.queries || [];
        let title = null, deadline = null, startDate = null, status = null;
        for (const query of queries) {
            const root = query?.state?.data?.data;
            if (!root) continue;
            const envelope = root;
            const hearingObj = envelope?.data && envelope?.data?.type === 'hearing' ? envelope.data : null;
            if (hearingObj && hearingObj.attributes) {
                deadline = hearingObj.attributes.deadline || deadline;
                startDate = hearingObj.attributes.startDate || startDate;
                // Try to get title directly from attributes if available
                if (hearingObj.attributes.title && !title) {
                    title = fixEncoding(String(hearingObj.attributes.title).trim());
                }
            }
            const included = Array.isArray(envelope?.included) ? envelope.included : [];
            const contents = included.filter(x => x?.type === 'content');
            
            // Look for title in content fields - try multiple field IDs
            if (!title) {
                // Field ID 1 is typically the title
                const titleContent = contents.find(c => String(c?.relationships?.field?.data?.id || '') === '1' && c?.attributes?.textContent);
                if (titleContent) title = fixEncoding(String(titleContent.attributes.textContent).trim());
            }
            
            // Fallback: look for any content field that looks like a title
            if (!title) {
                for (const content of contents) {
                    if (content?.attributes?.textContent) {
                        const text = String(content.attributes.textContent).trim();
                        // Title is typically shorter than 200 chars and doesn't contain multiple paragraphs
                        if (text.length > 0 && text.length < 200 && !text.includes('\n\n')) {
                            title = fixEncoding(text);
                            break;
                        }
                    }
                }
            }
            
            const statusRelId = hearingObj?.relationships?.hearingStatus?.data?.id;
            const statusIncluded = included.find(inc => inc.type === 'hearingStatus' && String(inc.id) === String(statusRelId));
            status = statusIncluded?.attributes?.name || status;
        }
        return { title, deadline, startDate, status };
    } catch {
        return { title: null, deadline: null, startDate: null, status: null };
    }
}

function isAwaitingConclusion(status) {
    return status && status.toLowerCase().includes('afventer konklusion');
}

console.log('=== Testing Title Extraction with Real Data ===\n');

console.log('Testing hearing 107 from real API data:');
const meta = extractMetaFromNextJson(realNextData);
console.log('Extracted metadata:', JSON.stringify(meta, null, 2));
console.log('\nStatus check:');
console.log('- Has "Afventer konklusion" status:', isAwaitingConclusion(meta.status));
console.log('- Should be included in search index:', !isAwaitingConclusion(meta.status));
console.log('- Final title:', meta.title || `Høring ${107}`);

// Test with API response structure
console.log('\n\nTesting with API list response structure:');

const apiResponse = {
    "data": [{
        "id": "107",
        "type": "hearing",
        "attributes": {
            "deadline": "2025-01-10T00:00:00Z",
            "startDate": "2024-11-15T00:00:00Z"
        },
        "relationships": {
            "hearingStatus": {"data": {"id": "5", "type": "hearingStatus"}},
            "contents": {"data": []}
        }
    }],
    "included": [{
        "id": "5",
        "type": "hearingStatus",
        "attributes": {
            "name": "Afventer konklusion"
        }
    }]
};

console.log('API Response hearing status:', apiResponse.included[0].attributes.name);
console.log('Should be filtered out:', isAwaitingConclusion(apiResponse.included[0].attributes.name));

console.log('\n=== Test Complete ===');