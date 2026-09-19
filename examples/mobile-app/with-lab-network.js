// Only the owned fixture talks to the local evaluator over HTTP.
const {withAndroidManifest}=require('expo/config-plugins');
module.exports=config=>withAndroidManifest(config,config=>{
  config.modResults.manifest.application[0].$['android:usesCleartextTraffic']='true';
  return config;
});
