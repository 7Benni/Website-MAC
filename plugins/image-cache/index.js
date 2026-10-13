// Netlify build plugin: persist the processed-image cache between deploys.
export const onPreBuild = async ({ utils }) => {
  await utils.cache.restore('.cache');
};

export const onPostBuild = async ({ utils }) => {
  await utils.cache.save('.cache');
};
