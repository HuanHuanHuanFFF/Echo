export default {
  id: 'heading-1000',
  version: '1',
  chunk(input) {
    return input.headingLines(1000);
  },
};
