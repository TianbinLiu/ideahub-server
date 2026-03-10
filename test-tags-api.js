/**
 * Test BiliBili Tags API Endpoint
 * Usage: node test-tags-api.js <bvid>
 */

const axios = require('axios');

const bvid = process.argv[2] || 'BV1Z1Q1Y8Ei6';

console.log('🧪 Testing BiliBili Tags API');
console.log('=====================================\n');
console.log(`Testing with BVID: ${bvid}`);
console.log(`URL: https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}\n`);

async function testTagsAPI() {
  try {
    const response = await axios.get('https://api.bilibili.com/x/tag/archive/tags', {
      params: { bvid },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/'
      }
    });

    console.log('=== API Response Status ===');
    console.log(`HTTP Status: ${response.status}`);
    console.log(`Response code: ${response.data.code}`);
    console.log(`Response message: ${response.data.message}\n`);

    if (response.data.code === 0 && Array.isArray(response.data.data)) {
      console.log('=== Tags Found ===');
      console.log(`Total tags: ${response.data.data.length}`);
      
      const tags = response.data.data.map(t => ({
        tag_id: t.tag_id,
        tag_name: t.tag_name,
        count: t.count?.use || 0,
        liked: t.liked || 0
      }));
      
      console.log('\nTag details:');
      tags.forEach((tag, i) => {
        console.log(`  ${i + 1}. ${tag.tag_name} (ID: ${tag.tag_id}, 使用次数: ${tag.count})`);
      });
      
      console.log('\n=== Extracted Tag Names ===');
      const tagNames = response.data.data.map(t => t.tag_name);
      console.log(tagNames.join(', '));
      
      console.log('\n✅ Tags API works correctly!');
    } else {
      console.log('⚠️  No tags returned or unexpected response format');
      console.log('Response data:', JSON.stringify(response.data, null, 2));
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testTagsAPI();
