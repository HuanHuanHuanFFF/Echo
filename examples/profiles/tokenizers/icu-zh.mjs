export default {
  id: 'icu-zh',
  version: '1',
  tokenize(text, context) {
    return context.icu(text, { locale: 'zh-CN', dictionary: [] });
  },
};
