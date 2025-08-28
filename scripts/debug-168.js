#!/usr/bin/env node

const axios = require('axios');

async function debugHearing168() {
    try {
        console.log('Fetching HTML for hearing 168...');
        const response = await axios.get('https://blivhoert.kk.dk/hearing/168');
        const html = response.data;
        
        // Find __NEXT_DATA__
        const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
        if (!match || !match[1]) {
            console.log('No __NEXT_DATA__ found');
            return;
        }
        
        console.log('Found __NEXT_DATA__, parsing...');
        const nextData = JSON.parse(match[1]);
        
        // Debug the structure
        console.log('nextData structure:');
        console.log('- Has props:', !!nextData?.props);
        console.log('- Has pageProps:', !!nextData?.props?.pageProps);
        console.log('- Has dehydratedState:', !!nextData?.props?.pageProps?.dehydratedState);
        
        // Look for title in different places
        const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
        console.log(`Found ${queries.length} queries`);
        
        // Check if there's data directly in pageProps
        if (nextData?.props?.pageProps) {
            const pageProps = nextData.props.pageProps;
            console.log('\nChecking pageProps directly:');
            console.log('- Keys:', Object.keys(pageProps));
            
            if (pageProps.hearing) {
                console.log('- Has hearing data');
                if (pageProps.hearing.title) {
                    console.log(`  FOUND TITLE IN HEARING: "${pageProps.hearing.title}"`);
                }
            }
        }
        
        for (let i = 0; i < queries.length; i++) {
            const query = queries[i];
            const root = query?.state?.data?.data;
            if (!root) continue;
            
            console.log(`\nQuery ${i}:`);
            console.log('- Has root data:', !!root);
            console.log('- Root type:', root?.type);
            
            const included = Array.isArray(root?.included) ? root.included : [];
            console.log('- Included items:', included.length);
            
            const contents = included.filter(x => x?.type === 'content');
            console.log('- Content items:', contents.length);
            
            for (const content of contents) {
                const fieldId = content?.relationships?.field?.data?.id;
                const textContent = content?.attributes?.textContent;
                console.log(`  Content: field=${fieldId}, hasText=${!!textContent}`);
                if (fieldId === '1' && textContent) {
                    console.log(`  FOUND TITLE: "${textContent}"`);
                }
            }
        }
        
        // Also check the main data
        const mainData = nextData?.props?.pageProps?.data;
        if (mainData) {
            console.log('\nMain data:');
            console.log('- Has data:', !!mainData);
            console.log('- Data type:', mainData?.type);
            
            const mainIncluded = Array.isArray(mainData?.included) ? mainData.included : [];
            console.log('- Main included items:', mainIncluded.length);
            
            const mainContents = mainIncluded.filter(x => x?.type === 'content');
            console.log('- Main content items:', mainContents.length);
            
            for (const content of mainContents) {
                const fieldId = content?.relationships?.field?.data?.id;
                const textContent = content?.attributes?.textContent;
                console.log(`  Main Content: field=${fieldId}, hasText=${!!textContent}`);
                if (fieldId === '1' && textContent) {
                    console.log(`  FOUND MAIN TITLE: "${textContent}"`);
                }
            }
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

debugHearing168();