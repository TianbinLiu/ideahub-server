// Test script to check BiliBili API response structure
const axios = require('axios');

// PLEASE REPLACE THIS WITH YOUR ACTUAL VIDEO BVID
// Extract from URL like: https://www.bilibili.com/video/BV1CgWde6ELY
const TEST_BVID = process.argv[2] || "BV1CgWde6ELY";

async function testBilibiliAPI() {
  try {
    console.log('\nTesting BiliBili API with BVID:', TEST_BVID);
    console.log('URL:', `https://api.bilibili.com/x/web-interface/view?bvid=${TEST_BVID}\n`);
    
    const apiRes = await axios.get("https://api.bilibili.com/x/web-interface/view", {
      params: {
        bvid: TEST_BVID
      },
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
      },
    });

    console.log('=== API Response Status ===');
    console.log('HTTP Status:', apiRes.status);
    console.log('Response code:', apiRes.data.code);
    console.log('Response message:', apiRes.data.message);
    
    if (apiRes.data.code !== 0) {
      console.error('\n❌ API returned error code:', apiRes.data.code);
      console.error('Message:', apiRes.data.message);
      return;
    }

    const data = apiRes?.data?.data;
    
    console.log('\n=== Video Basic Info ===');
    console.log('Title:', data.title);
    console.log('Description:', data.desc?.substring(0, 100));
    console.log('Author:', data.owner?.name);
    console.log('Category (tname):', data.tname);
    
    console.log('\n=== Tags Analysis ===');
    console.log('data.tag type:', typeof data.tag);
    console.log('data.tag value:', data.tag);
    console.log('\ndata.tags type:', typeof data.tags);
    console.log('data.tags isArray:', Array.isArray(data.tags));
    console.log('data.tags length:', Array.isArray(data.tags) ? data.tags.length : 'N/A');
    
    if (Array.isArray(data.tags) && data.tags.length > 0) {
      console.log('\n=== Tags Array Content ===');
      data.tags.forEach((tag, index) => {
        console.log(`\nTag ${index}:`, JSON.stringify(tag, null, 2));
      });
      
      console.log('\n=== Extracted Tag Names ===');
      const tagNames = data.tags.map(t => {
        if (typeof t === 'string') return t;
        return t.tag_name || t.name || t.tag || JSON.stringify(t);
      });
      console.log(tagNames);
    } else {
      console.log('\n⚠️  data.tags is empty or not an array!');
    }
    
    console.log('\n=== All Available Keys ===');
    console.log(Object.keys(data).join(', '));
    
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
  }
}

console.log('\n🔍 BiliBili API Tag Extraction Test');
console.log('=====================================');
testBilibiliAPI();

