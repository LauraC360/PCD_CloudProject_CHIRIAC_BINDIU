/**
 * Artillery Load Test Processor
 * 
 * Provides helper functions for the load test scenario
 */

module.exports = {
  selectRandomMovie: selectRandomMovie
};

function selectRandomMovie(context, ee, next) {
  // Select a random movie ID from the list
  const movieIds = context.vars.movieIds;
  const randomIndex = Math.floor(Math.random() * movieIds.length);
  context.vars.movieId = movieIds[randomIndex];
  
  return next();
}
