#!/usr/bin/env node

// Test script to verify title extraction from sample JSON data

// Sample JSON data structure from the API (based on the Next.js dehydrated state format)
const sampleData = {
    props: {
        pageProps: {
            dehydratedState: {
                queries: [{
                    state: {
                        data: {
                            data: {
                                data: {
                                    type: "hearing",
                                    id: "123",
                                    attributes: {
                                        deadline: "2024-01-15",
                                        startDate: "2023-12-01",
                                        // Sometimes title might be here
                                        title: "Lokalplan for Nørrebrogade"
                                    },
                                    relationships: {
                                        hearingStatus: {
                                            data: { id: "2" }
                                        },
                                        contents: {
                                            data: [
                                                { id: "content-1" },
                                                { id: "content-2" }
                                            ]
                                        }
                                    }
                                },
                                included: [
                                    {
                                        type: "content",
                                        id: "content-1",
                                        attributes: {
                                            textContent: "Forslag til lokalplan for området ved Nørrebrogade"
                                        },
                                        relationships: {
                                            field: {
                                                data: { id: "1" }  // Field ID 1 is typically the title
                                            }
                                        }
                                    },
                                    {
                                        type: "content",
                                        id: "content-2",
                                        attributes: {
                                            textContent: "Dette er en længere beskrivelse af lokalplanen som indeholder mange detaljer om området og formålet med planen..."
                                        },
                                        relationships: {
                                            field: {
                                                data: { id: "2" }
                                            }
                                        }
                                    },
                                    {
                                        type: "hearingStatus",
                                        id: "2",
                                        attributes: {
                                            name: "I høring"
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

// Sample with "Afventer konklusion" status
const sampleDataAwaitingConclusion = {
    props: {
        pageProps: {
            dehydratedState: {
                queries: [{
                    state: {
                        data: {
                            data: {
                                data: {
                                    type: "hearing",
                                    id: "456",
                                    attributes: {
                                        deadline: "2023-10-15",
                                        startDate: "2023-09-01"
                                    },
                                    relationships: {
                                        hearingStatus: {
                                            data: { id: "5" }
                                        }
                                    }
                                },
                                included: [
                                    {
                                        type: "content",
                                        id: "content-3",
                                        attributes: {
                                            textContent: "Cykelstrategi 2023-2030"
                                        },
                                        relationships: {
                                            field: {
                                                data: { id: "1" }
                                            }
                                        }
                                    },
                                    {
                                        type: "hearingStatus",
                                        id: "5",
                                        attributes: {
                                            name: "Afventer konklusion"
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

// Import the extraction function from server.js
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

console.log('=== Testing Title Extraction ===\n');

// Test case 1: Normal hearing
console.log('Test Case 1: Normal hearing');
const meta1 = extractMetaFromNextJson(sampleData);
console.log('Extracted metadata:', meta1);
console.log('Should be included in index:', !isAwaitingConclusion(meta1.status));

console.log('\n---\n');

// Test case 2: Hearing with "Afventer konklusion" status
console.log('Test Case 2: Hearing with "Afventer konklusion" status');
const meta2 = extractMetaFromNextJson(sampleDataAwaitingConclusion);
console.log('Extracted metadata:', meta2);
console.log('Should be included in index:', !isAwaitingConclusion(meta2.status));

console.log('\n---\n');

// Test case 3: Missing title
console.log('Test Case 3: Hearing without title');
const dataNoTitle = JSON.parse(JSON.stringify(sampleData));
delete dataNoTitle.props.pageProps.dehydratedState.queries[0].state.data.data.data.attributes.title;
dataNoTitle.props.pageProps.dehydratedState.queries[0].state.data.data.included = 
    dataNoTitle.props.pageProps.dehydratedState.queries[0].state.data.data.included.filter(i => i.type !== 'content');

const meta3 = extractMetaFromNextJson(dataNoTitle);
console.log('Extracted metadata:', meta3);
console.log('Fallback title would be:', meta3.title || `Høring ${123}`);

console.log('\n=== Test Complete ===');