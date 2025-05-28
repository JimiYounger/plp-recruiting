const Trello = require('trello');
const trello = new Trello(process.env.TRELLO_API_KEY, process.env.TRELLO_TOKEN);

/**
 * Creates a card on a specified Trello list with candidate information
 * @param {Object} candidateInfo - Object containing candidate information
 * @returns {Promise} - Promise that resolves with the created card
 */
async function createCandidateCard(candidateInfo) {
  const { firstName, lastName, email, phone, startDate } = candidateInfo;
  
  try {
    // Create card with candidate info
    const card = await trello.addCard(
      `${firstName} ${lastName} - Onboarding I-9`, // Card title
      `Email: ${email}\nPhone: ${phone}\nStart Date: ${startDate}`, // Card description
      process.env.TRELLO_LIST_ID // The ID of the list to add the card to
    );
    
    console.log(`Created Trello card for ${firstName} ${lastName}`);
    return card;
  } catch (error) {
    console.error('Error creating Trello card:', error);
    throw error;
  }
}

module.exports = {
  createCandidateCard
};