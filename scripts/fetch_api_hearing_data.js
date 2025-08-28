#!/usr/bin/env node

const axios = require('axios');

async function fetchHearingsFromAPI() {
    try {
        const response = await axios.get('https://blivhoert.kk.dk/api/hearing', {
            params: {
                PageIndex: 1,
                PageSize: 200,
                include: 'Contents,Contents.ContentType'
            },
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const targetIds = ['107', '167', '168', '190', '192'];
        const hearings = response.data.data || [];
        const included = response.data.included || [];
        
        console.log('Titler fra API:\n');
        
        for (const id of targetIds) {
            const hearing = hearings.find(h => h.id === id);
            if (!hearing) {
                console.log(`Høring ${id}: IKKE FUNDET I API`);
                continue;
            }
            
            // Find status
            const statusId = hearing.relationships?.hearingStatus?.data?.id;
            const status = included.find(i => i.type === 'hearingStatus' && i.id === statusId);
            const statusName = status?.attributes?.name || 'Ukendt';
            
            // Try to find title in content relationships
            const contentRefs = hearing.relationships?.contents?.data || [];
            let title = null;
            
            // Look for title in included content
            for (const ref of contentRefs) {
                const content = included.find(i => i.type === 'content' && i.id === ref.id);
                if (content) {
                    // Check if this is field ID 1 (title field)
                    const fieldId = content.relationships?.field?.data?.id;
                    if (fieldId === '1' && content.attributes?.textContent) {
                        title = content.attributes.textContent.trim();
                        break;
                    }
                }
            }
            
            console.log(`Høring ${id}: ${title || 'INGEN TITEL'} [Status: ${statusName}]`);
        }
        
    } catch (error) {
        console.error('Error fetching from API:', error.message);
    }
}

fetchHearingsFromAPI();