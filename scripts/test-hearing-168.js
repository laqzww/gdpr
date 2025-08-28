#!/usr/bin/env node

const axios = require('axios');

async function testHearing168() {
    try {
        // Hent høring 168 specifikt
        const url = 'https://blivhoert.kk.dk/api/hearing?PageIndex=1&PageSize=200';
        const response = await axios.get(url);
        
        const data = response.data;
        const hearing168 = data.data.find(h => h.id === '168');
        
        if (!hearing168) {
            console.log('Høring 168 ikke fundet');
            return;
        }
        
        console.log('Høring 168 fundet:');
        console.log('- ID:', hearing168.id);
        console.log('- Type:', hearing168.type);
        console.log('- Relationships:', JSON.stringify(hearing168.relationships, null, 2));
        
        // Find titlen i included array
        const included = data.included || [];
        console.log('\nLeder efter titel i included array...');
        
        // Check contents relationships
        const contentRels = hearing168.relationships?.contents?.data || [];
        console.log('Content relationships:', contentRels);
        
        for (const contentRef of contentRels) {
            const content = included.find(inc => 
                inc.type === 'content' && 
                String(inc.id) === String(contentRef.id)
            );
            
            if (content) {
                console.log('\nFandt content:', content.id);
                console.log('Field ID:', content.relationships?.field?.data?.id);
                console.log('Text content:', content.attributes?.textContent);
            }
        }
        
        // Hvis ingen titel blev fundet via contents, hent fra detail side
        console.log('\nHenter fra detail side...');
        const detailUrl = `https://blivhoert.kk.dk/hearing/${hearing168.id}`;
        console.log('URL:', detailUrl);
        
    } catch (error) {
        console.error('Fejl:', error.message);
    }
}

testHearing168();