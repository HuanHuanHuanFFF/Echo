export default {
  id: 'heading-500',
  version: '1',
  chunk(input) {
    return input.headingLines(500);
  },
};
