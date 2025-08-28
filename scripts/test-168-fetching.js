#!/usr/bin/env node

const axios = require('axios');

async function testHearing168() {
    const axiosInstance = axios.create({ 
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'kk-xyz=1' }, 
        timeout: 30000 
    });
    
    try {
        // Test 1: API endpoint
        console.log('=== Testing API endpoint ===');
        const apiResp = await axiosInstance.get('https://blivhoert.kk.dk/api/hearing/168');
        console.log('API Status:', apiResp.status);
        console.log('Has data:', !!apiResp.data?.data);
        console.log('Type:', apiResp.data?.data?.type);
        console.log('Contents:', apiResp.data?.data?.relationships?.contents?.data);
        
        // Check included array
        const included = apiResp.data?.included || [];
        const contents = included.filter(x => x?.type === 'content');
        console.log('Included contents:', contents.length);
        
        // Test 2: HTML page
        console.log('\n=== Testing HTML page ===');
        const htmlResp = await axiosInstance.get('https://blivhoert.kk.dk/hearing/168');
        console.log('HTML Status:', htmlResp.status);
        console.log('HTML Length:', htmlResp.data.length);
        
        // Check for __NEXT_DATA__
        const nextDataMatch = htmlResp.data.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
        if (nextDataMatch) {
            console.log('Found __NEXT_DATA__');
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                console.log('Parsed successfully');
                console.log('buildId:', nextData.buildId);
                console.log('isFallback:', nextData.isFallback);
                console.log('isPreview:', nextData.isPreview);
                console.log('query:', nextData.query);
                
                // Look deeper
                if (nextData.props?.pageProps) {
                    console.log('pageProps keys:', Object.keys(nextData.props.pageProps));
                }
            } catch (e) {
                console.log('Failed to parse __NEXT_DATA__:', e.message);
            }
        } else {
            console.log('No __NEXT_DATA__ found');
        }
        
        // Check for error messages
        if (htmlResp.data.includes('404') || htmlResp.data.includes('ikke fundet')) {
            console.log('WARNING: Page might be 404');
        }
        
        // Test 3: Try work.html approach
        console.log('\n=== Testing if hearing exists via meta endpoint ===');
        try {
            const metaResp = await axiosInstance.post('http://localhost:3010/api/hearing/168/meta');
            console.log('Meta response:', metaResp.data);
        } catch (e) {
            console.log('Meta endpoint error (expected if server not running):', e.message);
        }
        
    } catch (error) {
        console.error('Error:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
    }
}

testHearing168();