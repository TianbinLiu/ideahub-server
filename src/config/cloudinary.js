/**
 * Cloudinary Configuration
 * 云存储配置 - 用于存储用户上传的图片（头像、内容图片、封面等）
 * 
 * 环境变量需求：
 * - CLOUDINARY_CLOUD_NAME: Cloudinary 云名称
 * - CLOUDINARY_API_KEY: API 密钥
 * - CLOUDINARY_API_SECRET: API 密钥
 * 
 * 获取方式：https://console.cloudinary.com/
 */

const cloudinary = require('cloudinary').v2;

// Cloudinary 配置
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // 使用 HTTPS
});

/**
 * 验证 Cloudinary 配置是否正确
 */
function validateCloudinaryConfig() {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  
  if (!cloud_name || !api_key || !api_secret) {
    console.warn('⚠️  Cloudinary not configured. Image uploads will fail.');
    console.warn('   Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET');
    return false;
  }
  
  console.log('✅ Cloudinary configured:', cloud_name);
  return true;
}

module.exports = {
  cloudinary,
  validateCloudinaryConfig,
};
