/**
 * Test full scraper endpoint
 */

const axios = require('axios');

const testUrl = 'https://www.bilibili.com/video/BV1Z1Q1Y8Ei6';

console.log('🧪 Testing Scraper API Endpoint');
console.log('=====================================\n');
console.log(`Testing URL: ${testUrl}\n`);

async function testScraperAPI() {
  try {
    const response = await axios.post('http://localhost:4000/api/scraper/fetch', {
      url: testUrl
    });

    console.log('=== API Response ===');
    console.log(`Status: ${response.status}`);
    console.log(`Success: ${response.data.success}`);
    console.log(`Platform: ${response.data.platform}\n`);

    console.log('=== Extracted Data ===');
    console.log(`Title: ${response.data.title}`);
    console.log(`Author: ${response.data.author}`);
    console.log(`Content length: ${response.data.content?.length || 0} chars`);
    console.log(`Cover URL: ${response.data.coverImageUrl?.substring(0, 50)}...`);
    
    console.log('\n=== Tags ===');
    if (Array.isArray(response.data.tags)) {
      console.log(`Total tags: ${response.data.tags.length}`);
      console.log(`Tags: ${response.data.tags.join(', ')}`);
      
      if (response.data.tags.includes('守望先锋') && 
          response.data.tags.includes('毛加') && 
          response.data.tags.includes('拉玛刹') && 
          response.data.tags.includes('SSVGG')) {
        console.log('\n✅ All expected tags found!');
      } else {
        console.log('\n⚠️  Some expected tags missing');
      }
    } else {
      console.log('❌ Tags not returned as array');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

testScraperAPI();
