// Require necessary modules
const path = require("path");
const fastify = require("fastify")({ logger: true });
const Airtable = require("airtable");
const fetch = require('node-fetch');
const moment = require('moment-timezone');
const moments = require('moment');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const { parse } = require('csv-parse');
const pump = util.promisify(require('stream').pipeline);
const fastifyMultipart = require('@fastify/multipart')
const { parsePhoneNumber } = require('libphonenumber-js');
const trelloUtils = require('./trello-utils');

fastify.register(fastifyMultipart, {
  limits: {
    fieldNameSize: 1000, // Max field name size in bytes
    fieldSize: 1000,     // Max field value size in bytes
    fields: 100,         // Max number of non-file fields
    fileSize: 10000000,  // For multipart forms, the max file size in bytes
    files: 1,           // Max number of file fields
    headerPairs: 20000   // Max number of header key=>value pairs
  }
})


const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir);
}

require('dotenv').config();

// Configure Airtable with API Key
Airtable.configure({
    apiKey: process.env.AIRTABLE_API_KEY,
});
const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

function formatPhoneNumber(phoneNumber) {
  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '');
  
  // Ensure the number has 10 digits
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits[0] === '1') {
    return `+${digits}`;
  } else {
    // Return original if unable to format
    return null;
  }
}


// Add this function to fetch and cache office locations
async function fetchOfficeLocations() {
  try {
    const officeLocations = [];
    let offset;
    
    // Fetch all office locations (handles pagination)
    do {
      const params = {
        pageSize: 100,
        fields: ['Listing Location'] // Only fetch what we need
      };
      
      // Only add offset parameter if it exists
      if (offset) {
        params.offset = offset;
      }
      
      const response = await base('Office Locations').select(params).firstPage();
      
      officeLocations.push(...response);
      
      // Check if there might be more records
      if (response.length === 100) {
        // Get the last record's ID for the next offset
        offset = response[response.length - 1].id;
      } else {
        // No more records
        offset = null;
      }
    } while (offset);
    
    console.log(`Fetched ${officeLocations.length} office locations`);
    
    // Debug: Log first few office locations to see the structure
    console.log('Sample office locations:');
    officeLocations.slice(0, 3).forEach(office => {
      console.log('Office:', JSON.stringify(office.fields, null, 2));
    });
    
    return officeLocations;
  } catch (error) {
    console.error('Error fetching office locations:', error);
    throw error;
  }
}

// Add this function to match job location to office
function matchJobLocationToOffice(jobLocation, officeLocations) {
  if (!jobLocation) return ['recoHjWd6gEWmtgmH']; // Return No Office record for empty locations
  
  // Remove zip code and trim whitespace
  // Handles formats like "Charlotte, NC 28218" or "Charlotte, NC"
  const normalizedJobLocation = jobLocation
    .toString() // Ensure it's a string
    .replace(/\s+\d{5}(-\d{4})?$/g, '') // Remove 5-digit zip (with optional +4)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' '); // Normalize multiple spaces to single space
  
  console.log(`Normalized job location: "${normalizedJobLocation}" (from "${jobLocation}")`);
  
  // Find matching office(s)
  const matches = officeLocations.filter(office => {
    const listingLocationArray = office.fields['Listing Location'];
    if (!listingLocationArray || !Array.isArray(listingLocationArray)) return false;
    
    // Check each location in the array (since it's a multiple select field)
    return listingLocationArray.some(locationString => {
      if (typeof locationString !== 'string') return false;
      
      // Normalize the listing location for comparison
      const normalizedListingLocation = locationString.trim().toLowerCase();
      
      // Create variations to match against
      // Handle both "Charlotte, NC" and "Charlotte NC" formats
      const jobLocationWithComma = normalizedJobLocation.replace(/(\w+)\s+(\w{2})$/i, '$1, $2');
      const jobLocationWithoutComma = normalizedJobLocation.replace(/,\s*/g, ' ');
      
      // Debug log for first few comparisons
      if (normalizedJobLocation.includes('charlotte') || normalizedJobLocation.includes('des moines')) {
        console.log(`Comparing "${normalizedJobLocation}" (and "${jobLocationWithComma}") to "${normalizedListingLocation}"`);
      }
      
      // Check if either format matches
      return normalizedListingLocation === normalizedJobLocation ||
             normalizedListingLocation === jobLocationWithComma ||
             normalizedListingLocation === jobLocationWithoutComma;
    });
  });
  
  if (matches.length > 0) {
    console.log(`Found ${matches.length} office match(es) for "${jobLocation}"`);
    return matches.map(match => match.id);
  }
  
  console.log(`No office match found for "${jobLocation}", using No Office record`);
  return ['recoHjWd6gEWmtgmH']; // No Office record ID
}

// Updated processCSV function with office matching
async function processCSV(filePath, csvType) {
  const parseFile = util.promisify(parse);
  const fileContent = await fs.promises.readFile(filePath, 'utf8');
  
  const records = await parseFile(fileContent, {
    columns: true,
    skip_empty_lines: true
  });
  console.log('Parsed CSV records:', records);
  
  // Fetch office locations once for all records
  const officeLocations = await fetchOfficeLocations();
  
  let processedRecords = [];

  if (csvType === 'indeed') {
    processedRecords = records
      .filter(record => {
        const formattedPhone = formatPhoneNumber(record.phone);
        return formattedPhone !== null;
      })
      .map(record => {
        const formattedPhone = formatPhoneNumber(record.phone);
        const formattedDate = moment(record['date'], 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD');
        
        // Match job location to office
        const officeRecordIds = matchJobLocationToOffice(record['job location'], officeLocations);
        
        return {
          'Full Name': record.name,
          'Email': record.email,
          'Phone': formattedPhone,
          'Job Title': record['job title'] || '',
          'Current Employment': record['current role'] || '',
          'Job Location': record['job location'] || '',
          'Candidate Location': record['candidate location'] || '',
          'Current Role': record['current role'] || '',
          'Date Applied': formattedDate,
          'Status': 'Applied',
          'Referred By': 'Indeed',
          'Source': 'Indeed',
          'utmId': 'Indeed',
          'Applied': true,
          'Office Record': officeRecordIds // New field with linked office record IDs
        };
      });
  } else if (csvType === 'handshake') {
    // For Handshake, we might not have job location data
    // You could add office matching here if Handshake provides location info
    processedRecords = records.map(record => {
      const formattedDate = moment(record['Application Date'], 'YYYY-MM-DD HH:mm:ss UTC').format('YYYY-MM-DD');
      return {
        'Full Name': `${record['Student First Name']} ${record['Student Last Name']}`,
        'Email': record['Student Email'],
        'Phone': '',
        'Job Title': record['Applied To Name'] ? record['Applied To Name'].trim() : 'Unspecified',
        'Current Employment': '',
        'Job Location': '',
        'Candidate Location': '',
        'Current Role': '',
        'Date Applied': formattedDate,
        'Status': 'Applied',
        'Referred By': 'Handshake',
        'Source': 'Handshake',
        'utmId': 'Handshake',
        'Applied': true,
        'Office Record': ['recoHjWd6gEWmtgmH'] // Default to No Office for Handshake
      };
    });
  } else if (csvType === 'ziprecruiter') {
    processedRecords = records.map(record => {
      const formattedDate = moment(record['Apply Date'], 'M/D/YY').format('YYYY-MM-DD');
      
      // ZipRecruiter might have job location in the Job field or separate
      // Adjust based on your actual CSV structure
      const officeRecordIds = matchJobLocationToOffice(record['Job Location'] || '', officeLocations);
      
      return {
        'Full Name': record.Name,
        'Email': record.Email,
        'Phone': formatPhoneNumber(record['Phone Number']),
        'Job Title': record.Job,
        'Current Employment': '',
        'Job Location': `${record.City}, ${record.State}`,
        'Candidate Location': '',
        'Current Role': '',
        'Date Applied': formattedDate,
        'Status': 'Applied',
        'Referred By': 'ZipRecruiter',
        'Source': 'ZipRecruiter',
        'utmId': 'ZipRecruiter',
        'Applied': true,
        'Candidate URL': record['Candidate Overview'],
        'Resume URL': record.Resume,
        'Office Record': officeRecordIds
      };
    });
  } else if (csvType === 'bulkonboarding') {
    processedRecords = records.map(record => {
      return {
        'Full Name': record['Full Name'],
        'Email': record['Email'],
        'Phone': formatPhoneNumber(record['Phone']),
        'Role Abbreviation': record['Role Abbreviation'],
        'Start Date': moment(record['Start Date'], 'DD-MMM').format('YYYY-MM-DD'),
        'Status': 'Bulk Onboarding',
        'Opt In': true,
        'Source': 'Bulk Onboarding',
        'Referred By': 'Bulk Onboarding',
        'Office Record': ['recoHjWd6gEWmtgmH'] // Default to No Office for bulk onboarding
      };
    });
  }

  console.log('Processed records with office matching:', processedRecords);
  return processedRecords;
}

async function uploadToAirtable(records) {
  try {
    let createdOrUpdatedRecords = [];
    let createdCount = 0;
    let updatedCount = 0;
    
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10);
      
      for (const record of batch) {
        // Use the Phone field for Indeed and Email field for Handshake as the unique identifier
        const uniqueIdentifier = record['Phone'] || record['Email'];
        
        // Escape single quotes in the identifier to prevent formula errors
        const escapedIdentifier = uniqueIdentifier ? uniqueIdentifier.replace(/'/g, "\\'") : '';
        
        const filterFormula = record['Phone'] 
          ? `{Phone} = '${escapedIdentifier}'`
          : `{Email} = '${escapedIdentifier}'`;
        
        // Prepare the record for Airtable
        // Office Record field needs to be in the correct format for linked records
        const airtableRecord = {
          ...record
        };
        
        // Ensure Office Record is properly formatted as an array
        if (record['Office Record'] && !Array.isArray(record['Office Record'])) {
          airtableRecord['Office Record'] = [record['Office Record']];
        }
        
        try {
          // Check if a record with this unique identifier already exists
          const existingRecords = await base('MASTER').select({
            filterByFormula: filterFormula,
            maxRecords: 1
          }).firstPage();
          
          if (existingRecords.length > 0) {
            // Update existing record
            // For updates, we might want to append to existing Office Records rather than replace
            if (airtableRecord['Office Record']) {
              const existingOfficeRecords = existingRecords[0].fields['Office Record'] || [];
              // Merge existing and new office records, removing duplicates
              const mergedOfficeRecords = [...new Set([...existingOfficeRecords, ...airtableRecord['Office Record']])];
              airtableRecord['Office Record'] = mergedOfficeRecords;
            }
            
            const updatedRecord = await base('MASTER').update(
              existingRecords[0].id, 
              airtableRecord, 
              { typecast: true }
            );
            createdOrUpdatedRecords.push(updatedRecord);
            updatedCount++;
            console.log(`Updated record for ${uniqueIdentifier}`);
          } else {
            // Create new record
            const newRecord = await base('MASTER').create(
              airtableRecord, 
              { typecast: true }
            );
            createdOrUpdatedRecords.push(newRecord);
            createdCount++;
            console.log(`Created record for ${uniqueIdentifier}`);
          }
        } catch (recordError) {
          console.error(`Error processing record for ${uniqueIdentifier}:`, recordError);
          // Log the problematic record for debugging
          console.error('Problematic record:', JSON.stringify(airtableRecord, null, 2));
          
          // Continue with next record instead of stopping entire batch
          continue;
        }
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log('Upload complete:');
    console.log('- Total processed:', createdOrUpdatedRecords.length);
    console.log('- Created:', createdCount);
    console.log('- Updated:', updatedCount);
    console.log('- Errors:', records.length - createdOrUpdatedRecords.length);
    
    return {
      totalProcessed: createdOrUpdatedRecords.length,
      created: createdCount,
      updated: updatedCount,
      errors: records.length - createdOrUpdatedRecords.length,
      records: createdOrUpdatedRecords
    };
  } catch (error) {
    console.error('Error uploading to Airtable:', error);
    throw error;
  }
}



async function createRecord(tableName, data) {
    try {
        const record = await base(tableName).create(data);
        console.log('Record created successfully:', record.getId());
        return record;
    } catch (error) {
        console.error('Error creating record:', error);
        throw error; // Rethrow the error so it can be caught by the caller
    }
}



// Function to fetch event data from Demio
async function fetchDemioEventData(eventId, active) {
    const url = `https://my.demio.com/api/v1/event/${eventId}?active=${active}`;
    const headers = {
        'Content-Type': 'application/json',
        'Api-Key': process.env.DEMIO_API_KEY,
        'Api-Secret': process.env.DEMIO_API_SECRET
    };

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching data from Demio:', error);
        throw error;
    }
}

// Add this function after your imports and configurations, but before your route definitions

function constructFreshservicePayload(data) {
    return {
        FirstName: data.legalFirstName,
        LastName: data.lastName,
        JobTitleID: data.roleInfo.freshserviceId,
        DepartmentID: data.roleInfo.freshserviceDepartment,
        ImmediateManagerID: data.immediateSupervisorInfo.freshserviceId,
        PhoneNumber: data.phone,
        StartDate: new Date(data.startDate).toISOString(),
        SalesOfficeLocation: "N/A",
        LocationID: data.teamInfo.freshserviceLocationId,
        ExtraNotes: data.notes,
        SalesforceNewUser: "Yes",
        SalesforcePLResource: "No",
        TShirtSize: data.shirtSize,
        ApparelNeededDate: new Date(data.startDate).toISOString(),
        SubmittedByEmail: data.hiringManagerInfo.email,
        ImmediateManagerEmail: data.immediateSupervisorInfo.email,
        EnergyConsultantSalesManager: data.roleInfo.EnergyConsultantSalesManager,
        LoanPortalAccess: data.roleInfo.LoanPortalAccess,
        EmployeePersonalEmail: data.email,
        RecruitingChannel: data.recruitingChannel,
        ReferredBy: data.referredByInfo?.email || '',
    };
}

// Route to fetch sessions for a specific event
fastify.get('/demio/event/:eventId/sessions', async (request, reply) => {
    try {
        const { eventId } = request.params;
        const eventData = await fetchDemioEventData(eventId, true); // Assuming 'true' for active sessions
        reply.send(eventData);
    } catch (error) {
        reply.status(500).send({ error: 'Failed to retrieve Demio event data' });
    }
});
// Route to serve the registration page
fastify.get('/register', async (request, reply) => {
    try {
        return reply.view('/src/pages/opnightregistration.hbs');
    } catch (error) {
        console.error('Error rendering registration page:', error);
        reply.status(500).send({ error: 'Failed to load registration page' });
    }
});

fastify.get('/registerprod', async (request, reply) => {
    try {
        return reply.view('/src/pages/opnightregistrationprod.hbs');
    } catch (error) {
        console.error('Error rendering registration page:', error);
        reply.status(500).send({ error: 'Failed to load registration page' });
    }
});

async function updateAirtableRecord(recordId, updatedFields) {
    return new Promise((resolve, reject) => {
        base('MASTER').update(recordId, updatedFields, (err, record) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(record);
        });
    });
}
const baseSecond = Airtable.base(process.env.AIRTABLE_BASE_ID_SECOND);

async function getActiveTeamMembers() {
    try {
        const records = await baseSecond('Team Members').select({
            filterByFormula: "NOT({Role} = 'TERM')",
            sort: [{field: 'Full Name', direction: 'asc'}] // Add sorting by Full Name
        }).all();

        // Map the records to get an array of objects with full names and record IDs
        const activeTeamMembers = records.map(record => ({
            name: record.get('Full Name'),
            id: record.id // Store the record ID
        })).filter(member => member.name); // Ensure the member has a name

        return activeTeamMembers;
    } catch (error) {
        console.error('Error getting active team members:', error);
        throw error;
    }
}

fastify.post('/videoask/webhook', async (request, reply) => {
    try {
        const data = request.body; // Assuming the body is already parsed as JSON
        console.log('Webhook received:', JSON.stringify(data, null, 2)); // Log the incoming data

        // Extract necessary fields from the JSON
        const contact = data.contact;
        const variables = contact.variables;
        const answers = contact.answers;

        const recordId = variables.recordid;

        // Define the fields to update
        const updatedFields = {
            "Video Interview Submitted": true,
            "Video Interview Share Link": contact.share_url || "N/A",
            "Questionnaire Score": contact.scoring["@score"] || "N/A",
            "Status": "Video Interview - Needs Review",
            "Disqualified": false
        };

        let partialSubmission = false;

        // Parse answers and populate corresponding fields
        answers.forEach(answer => {
            switch (answer.question_id) {
                case "8dfb044b-2d30-4d13-8e71-3eddd65665ea":
                    updatedFields["Qualifier 4"] = answer.poll_option_content || "N/A";
                    break;
                case "cebfcd9d-005a-4989-a2f9-48f5b9ed1c2e":
                    updatedFields["Qualifier 1"] = answer.poll_option_content || "N/A";
                    break;
                case "d4eeb877-04f3-440f-b6b6-c5654683cc93":
                    updatedFields["Qualifier 2"] = answer.poll_option_content || "N/A";
                    break;
                case "4ba23ff4-d6e6-408e-acd3-1136d194eff0":
                    updatedFields["Qualifier 3"] = answer.poll_option_content || "N/A";
                    break;
                case "a3178a58-e897-493a-a4fe-99796b9fc15a":
                    updatedFields["Video Interview Question 1"] = answer.transcription || "N/A";
                    break;
                case "88bf64da-a7bb-4a6a-baa7-dab660673aa1":
                    updatedFields["Video Interview Question 2"] = answer.transcription || "N/A";
                    break;
                case "f0ead8b7-e340-4580-b991-9d6ea62aaa7e":
                    updatedFields["Video Interview Question 3"] = answer.transcription || "N/A";
                    break;
                case "6f39b3ba-d46a-4a4f-b8cd-2034ad092c81":
                    updatedFields["Video Interview Question 4"] = answer.transcription || "N/A";
                    break;
                case "adbefac1-4fc7-4cc6-b5e7-3ddd11a9995b":
                    updatedFields["Video Interview Question 5"] = answer.transcription || "N/A";
                    break;
                case "67137bed-fe39-4b4e-b817-fc6468e5c842":
                    updatedFields["Questionnaire Question 1"] = answer.poll_option_content || "N/A";
                    break;
                case "653d2454-21ac-4541-bc4b-32b3c1fc8e55":
                    updatedFields["Questionnaire Question 2"] = answer.poll_option_content || "N/A";
                    break;
                case "51e65a2f-dbc6-462e-8d8a-98a762c6f86f":
                    updatedFields["Questionnaire Question 3"] = answer.poll_option_content || "N/A";
                    break;
                case "80a69edd-d0d5-49c9-9f51-78705c3e8d14":
                    updatedFields["Questionnaire Question 4"] = answer.poll_option_content || "N/A";
                    break;
                case "2640ec4c-38a4-44fc-ba37-d2afa22c87d3":
                    updatedFields["Questionnaire Question 5"] = answer.poll_option_content || "N/A";
                    break;
                case "cd42c2ac-e987-4a12-848c-35d1d689d085":
                    updatedFields["Questionnaire Question 6"] = answer.poll_option_content || "N/A";
                    break;
                case "fe75313d-5293-46ab-a68c-d0b7be0eb00c":
                    updatedFields["Questionnaire Question 7"] = answer.poll_option_content || "N/A";
                    break;
                default:
                    break;
            }

            // Check if any field is "N/A" indicating a partial submission
            if (!answer.poll_option_content || !answer.transcription) {
                partialSubmission = true;
            }
        });

        // Update partial submission field
        if (partialSubmission) {
            updatedFields["Partial Video Interview"] = true;
        }

        // Update the Airtable record
        await updateAirtableRecord(recordId, updatedFields);

        // Create payload with recordId and updatedFields
        const webhookPayload = {
            recordId: recordId,
            updatedFields: updatedFields
        };

        // Send the data to the webhook
        await axios.post('https://hook.us1.make.com/ce1mlut7nicwj6mj90ahm65fgu9rd0k9', webhookPayload);

        reply.send({ status: 'success' });
    } catch (error) {
        console.error('Error processing webhook data:', error);
        reply.status(500).send({ error: 'Failed to process webhook data' });
    }
});
// Example usage of the function within a Fastify route
fastify.get('/active-team-members', async (request, reply) => {
    try {
        const teamMembers = await fetchActiveTeamMembers(); // Assuming this function is available and behaves similarly to the example you've provided.
        reply.send({ teamMembers: teamMembers.map(member => ({
            id: member.id,
            name: member.name,
            role: member.role,
            freshserviceId: member.freshserviceId,
            email: member.email,
            phone: member.phone
            
        })) });
    } catch (error) {
        reply.status(500).send({ error: 'Failed to retrieve team members' });
    }
});

// Fetch branches from the Branch table in baseSecond
fastify.get('/branches', async (request, reply) => {
    try {
        const records = await baseSecond('Branch').select({
            view: 'Grid view'
        }).firstPage();
        
        const branches = records.map(record => ({
            id: record.id,
            name: record.get('Branch')
        }));
        
        return reply.send({ branches });
    } catch (error) {
        console.error('Error fetching branches:', error);
        return reply.status(500).send('Error fetching branches');
    }
});


async function createRecordInSecondBase(fields) {
    return new Promise((resolve, reject) => {
        baseSecond('Team Members').create(fields, (err, record) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(record);
        });
    });
}

async function getInformationFromSecondBase(tableName, recordId) {
    return new Promise((resolve, reject) => {
        baseSecond(tableName).find(recordId, (err, record) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(record);
        });
    });
}

// Function to fetch team members with specified criteria
async function fetchTeamMembers() {
    return new Promise((resolve, reject) => {
        // Define an empty array to hold our filtered team members
        let filteredTeamMembers = [];
        // Fetch records from "Team Members" table
        baseSecond('Team Members').select({
            // Modified filter to include Manager, Admin, and Executive role types
            filterByFormula: "AND(NOT({Role} = 'TERM'), OR({Role Type} = 'Manager', {Role Type} = 'Admin', {Role Type} = 'Executive'))",
            fields: ['Full Name', 'Role', 'Freshservice User ID', 'Email', 'Phone', 'Google User ID']
        }).eachPage(function page(records, fetchNextPage) {
            // This function (`page`) will get called for each page of records.
            records.forEach(function(record) {
                // For each record, push relevant data to our array
                filteredTeamMembers.push({
                    id: record.id,
                    name: record.get('Full Name'),
                    role: record.get('Role'),
                    freshserviceId: record.get('Freshservice User ID'),
                    email: record.get('Email'),
                    phone: record.get('Phone'),
                    googleId: record.get('Google User ID'),
                });
            });
            fetchNextPage();
        }, function done(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(filteredTeamMembers);
        });
    });
}

async function fetchPayscales() {
    return new Promise((resolve, reject) => {
        let payscales = []; // Array to hold payscale data

        // Fetch records from the "Payscale" table
        baseSecond('Payscale').select({
            fields: ['Name', 'Requires Approval', 'Approver'] // Remove 'id' from fields list
        }).eachPage(function page(records, fetchNextPage) {
            // Process each page of records
            records.forEach(function(record) {
                // For each record, push the relevant data to our array
                payscales.push({
                    id: record.getId(), // Use record.getId() instead of record.get('id')
                    name: record.get('Name'),
                    requiresApproval: record.get('Requires Approval') || false,
                    approver: record.get('Approver') || []
                });
            });

            fetchNextPage();

        }, function done(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(payscales);
        });
    });
}

// Function to fetch team members with specified criteria
async function fetchActiveTeamMembers() {
    return new Promise((resolve, reject) => {
        // Define an empty array to hold our filtered team members
        let filteredTeamMembers = [];

        // Fetch records from "Team Members" table
        baseSecond('Team Members').select({
            // Add filter to only select records that meet your criteria
            filterByFormula: "AND(NOT({Role} = 'TERM'))",
            fields: ['Full Name', 'Role', 'Freshservice User ID', 'Email', 'Phone', 'Google User ID'] // Adjust fields based on what you need (e.g., Name, Role)
        }).eachPage(function page(records, fetchNextPage) {
            // This function (`page`) will get called for each page of records.

            records.forEach(function(record) {
                // For each record, push relevant data to our array
                filteredTeamMembers.push({
                      id: record.id,
                      name: record.get('Full Name'), // Corrected from 'Name' to 'Full Name'
                      role: record.get('Role'),
                      freshserviceId: record.get('Freshservice User ID'),
                      email: record.get('Email'),
                      phone: record.get('Phone'),
                      googleId: record.get('Google User ID'),
                  });
            });

            fetchNextPage();

        }, function done(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(filteredTeamMembers);
        });
    });
}


async function fetchTeams() {
    return new Promise((resolve, reject) => {
        let teams = []; // Array to hold team names

        // Fetch records from the "Team" table
        baseSecond('Team').select({
            fields: ['Name', 'Paylocity Work Location', 'Paylocity CC1', 'Paylocity Recruiting URL', 'Sales Manager', 'Area Director', 'Regional Director', 'Divisional VP', 'Region', 'Branch', 'Team', 'Area', 'Freshservice Location ID', 'Team Icon', 'Recruiter Google ID', 'HR Google ID', 'HR Rep Name', 'Paylocity Application Link', 'teamId',] // Assuming 'Name' is the field you want
        }).eachPage(function page(records, fetchNextPage) {
            // This function gets called for each page of records.

            records.forEach(function(record) {
                // For each record, push the name to our array
                teams.push({
                    id: record.id,
                    name: record.get('Name'),
                    paylocityWL: record.get('Paylocity Work Location'),
                    paylocityCC1: record.get('Paylocity CC1'),
                    paylocityURL: record.get('Paylocity Recruiting URL'),// Get the 'Name' field from each record
                    salesManager: record.get('Sales Manager'),
                    areaDirector: record.get('Area Director'),
                    regionalDirector: record.get('Regional Director'),
                    manager: record.get('Sales Manager'),
                    divisionalVp: record.get('Divisional VP'),
                    region: record.get('Region'),
                    branch: record.get('Branch'),
                    team: record.get('Team'),
                    area: record.get('Area'),
                    freshserviceLocationId: record.get('Freshservice Location ID'),
                    teamIcon: record.get('Team Icon'),
                    recruiter: record.get('Recruiter Google ID'),
                    hrRep: record.get('HR Google ID'),
                    hrRepName: record.get('HR Rep Name'),
                    applicationLink: record.get('Paylocity Application Link'),
                    teamId: record.get('teamId'),
                });
            });

            fetchNextPage();

        }, function done(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(teams);
        });
    });
}


async function fetchRoles() {
    return new Promise((resolve, reject) => {
        // Define an empty array to hold the roles
        let roles = [];
        // Fetch records from "Role" table
        baseSecond('Role').select({
            // Add 'Payscale' to the fields list
            fields: ['Name', 'Freshservice ID', 'Role Abbreviation', 'Role Type', 'Department', 
                    'Paylocity Onboarding Event Name', 'Tax Form', 'Background Check Name', 
                    'Freshservice Department', 'EnergyConsultantSalesManager', 'LoanPortalAccess', 'Payscale']
        }).eachPage(function page(records, fetchNextPage) {
            records.forEach(function(record) {
                roles.push({
                    id: record.id,
                    name: record.get('Name'),
                    freshserviceId: record.get('Freshservice ID'),
                    roleAbbrv: record.get('Role Abbreviation'),
                    roleType: record.get('Role Type'),
                    department: record.get('Department'),
                    paylocityEventName: record.get('Paylocity Onboarding Event Name'),
                    taxForm: record.get('Tax Form'),
                    backgroundCheck: record.get('Background Check Name'),
                    freshserviceDepartment: record.get('Freshservice Department'),
                    EnergyConsultantSalesManager: record.get('EnergyConsultantSalesManager'),
                    LoanPortalAccess: record.get('LoanPortalAccess'),
                    // Add the Payscale field - this will be an array with one item if linked
                    payscale: record.get('Payscale') || []
                });
            });
            fetchNextPage();
        }, function done(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(roles);
        });
    });
}


// Setup our static files
fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/", // optional: default '/'
});

// Formbody lets us parse incoming forms
fastify.register(require("@fastify/formbody"));



const handlebars = require("handlebars");

// Register the eq helper
handlebars.registerHelper('eq', function(a, b) {
    return a === b;
});

handlebars.registerHelper('multiply', function(a, b) {
    return a * b;
});

fastify.register(require("@fastify/view"), {
    engine: {
        handlebars: handlebars,
    },
});

fastify.register(require('@fastify/cors'), {
    // Configure as needed
});

// Load and parse SEO data
const seo = require("./src/seo.json");
if (seo.url === "glitch-default") {
  seo.url = `https://${process.env.PROJECT_DOMAIN}.glitch.me`;
}

/**
 * Our home page route
 *
 * Returns src/pages/index.hbs with data built into it
 */
fastify.get('/', async (request, reply) => {
    try {
        // Fetch all office records from the 'Office Locations' table
        const records = await base('Office Locations').select({
            fields: ['Name', 'Office Icon URL'] // Assuming 'Name' is the field that contains the office names
        }).all();

        // Transform records to extract necessary data
        const offices = records.map(record => ({
            id: record.id,
            Name: record.get('Name'),
            officeIcon: record.get('Office Icon URL'),
        }));
        offices.sort((a, b) => a.Name.localeCompare(b.Name));

        // Render the index.hbs template and pass the offices data
        return reply.view('/src/pages/index.hbs', { offices });
    } catch (error) {
        console.error('Error fetching offices:', error);
        return reply.view('/src/pages/error.hbs', { error: 'Error fetching office data' });
    }
});
/**
 * Our POST route to handle and react to form submissions
 *
 * Accepts body data indicating the user choice
 */
fastify.post("/", function (request, reply) {
  // Build the params object to pass to the template
  let params = { seo: seo };

  // If the user submitted a color through the form it'll be passed here in the request body
  let color = request.body.color;

  // If it's not empty, let's try to find the color
  if (color) {
    // ADD CODE FROM TODO HERE TO SAVE SUBMITTED FAVORITES

    // Load our color data file
    const colors = require("./src/colors.json");

    // Take our form submission, remove whitespace, and convert to lowercase
    color = color.toLowerCase().replace(/\s/g, "");

    // Now we see if that color is a key in our colors object
    if (colors[color]) {
      // Found one!
      params = {
        color: colors[color],
        colorError: null,
        seo: seo,
      };
    } else {
      // No luck! Return the user value as the error property
      params = {
        colorError: request.body.color,
        seo: seo,
      };
    }
  }

  // The Handlebars template will use the parameter values to update the page with the chosen color
  return reply.view("/src/pages/index.hbs", params);
});

// Run the server and report out to the logs
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Your app is listening on ${address}`);
  }
);

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function(req, body, done) {
  try {
    var json = JSON.parse(body)
    done(null, json)
  } catch (err) {
    err.statusCode = 400
    done(err, undefined)
  }
})


fastify.get("/:eventId", async (request, reply) => {
  const eventId = request.params.eventId;
  let attendeesData = [];
  let eventName = ""; // Variable to store the event name

  try {
    // Fetch the event data from 'Opportunity Night Schedule' table
    const eventData = await base('Opportunity Night Schedule').find(eventId);
    eventName = eventData.fields['Name']; // Get the Name of the event
    const attendeeIds = eventData.fields['Attendees'];

    // Fetch attendees' details from 'MASTER' table
    if (attendeeIds && attendeeIds.length > 0) {
      attendeesData = await Promise.all(attendeeIds.map(async (id) => {
        const record = await base('MASTER').find(id);
        return {
          firstName: record.get('First Name'),
          lastName: record.get('Last Name'),
          phone: record.get('Phone'),
          email: record.get('Email'),
          attended: record.get('Attended Opportunity Night'),
          recordId: record.get('Record ID'),
        };
      }));
    }

    // Render the HTML page with attendees' data and event name
    return reply.view("/src/pages/event.hbs", { attendees: attendeesData, eventId, eventName });
  } catch (error) {
    console.error('Error fetching data:', error);
    return reply.view("/src/pages/error.hbs",
{ error: 'Error fetching event data' });
}
});
fastify.post("/update-record/:recordId", async (request, reply) => {
  const { recordId } = request.params;
  const updatedData = request.body; // Data to update

  try {
    // Combine firstName and lastName into a single Full Name field
    const fullName = `${updatedData.firstName} ${updatedData.lastName}`;

    // Use the Airtable API to update the record in the MASTER table
    const record = await base("MASTER").update(recordId, {
      "Full Name": fullName, // Update Full Name field
      "Phone": updatedData.phone,
      "Email": updatedData.email,
      "Attended Opportunity Night": true, // Assuming this is a checkbox field
    });

    return reply.send({ success: true, message: "Record updated successfully" });
  } catch (error) {
    console.error("Error updating record:", error);
    return reply.status(500).send({ success: false, message: "Error updating record" });
  }
});

// Create or update a record in the MASTER table
fastify.post("/create-update-record", async (request, reply) => {
  const requestData = request.body; // Data to create or update the record

  try {
    // Combine firstName and lastName into a single Full Name field
    const fullName = `${requestData.firstName} ${requestData.lastName}`;

    // Check if the record already exists based on the email
    const existingRecord = await base("MASTER")
      .select({
        maxRecords: 1,
        filterByFormula: `{Email} = '${requestData.email}'`, // Use email as the filter
      })
      .firstPage();

    if (existingRecord && existingRecord.length > 0) {
      // If the record exists, update it
      const recordId = existingRecord[0].id;
      await base("MASTER").update(recordId, {
        "Full Name": fullName,
        "Phone": requestData.phone,
        "Email": requestData.email,
        "Attended Opportunity Night": true,
        "Attended Opportunity Night Event Record": [requestData.eventId], // Add eventId to the field
      });
      return reply.send({ success: true, message: "Record updated successfully" });
    } else {
      // If the record doesn't exist, create a new one
      await base("MASTER").create([
        {
          fields: {
            "Full Name": fullName,
            "Phone": requestData.phone,
            "Email": requestData.email,
            "Attended Opportunity Night": true,
            "Attended Opportunity Night Event Record": [requestData.eventId],// Add eventId to the field
            "Status": "Registered At Opportunity Night", // Set the Status field
          },
        },
      ]);
      return reply.send({ success: true, message: "Record created successfully" });
    }
  } catch (error) {
    console.error("Error creating/updating record:", error);
    return reply.status(500).send({ success: false, message: "Error creating/updating record" });
  }
});

// Define a route for /{{eventid}}/optin
fastify.get("/:eventId/optin", async (request, reply) => {
  const eventId = request.params.eventId;
  let attendeesData = [];
  let eventName = ""; // Variable to store the event name
  let eventLocation = ""; // Variable to store the event location

  try {
    // Fetch the event data from 'Opportunity Night Schedule' table
    const eventData = await base('Opportunity Night Schedule').find(eventId);
    eventName = eventData.fields['Name']; // Get the Name of the event
    eventLocation = eventData.fields['Location']; // Get the Location of the event
    const attendeeIds = eventData.fields['Attendees'];

    // Fetch attendees' details from 'MASTER' table
    if (attendeeIds && attendeeIds.length > 0) {
      attendeesData = await Promise.all(attendeeIds.map(async (id) => {
        const record = await base('MASTER').find(id);
        return {
          firstName: record.get('First Name'),
          lastName: record.get('Last Name'),
          phone: record.get('Phone'),
          email: record.get('Email'),
          attended: record.get('Attended Opportunity Night'),
          recordId: record.get('Record ID'),
        };
      }));
    }

    // Render the HTML page with attendees' data and event name
    return reply.view("/src/pages/optin.hbs", { attendees: attendeesData, eventId, eventName, eventLocation });
  } catch (error) {
    console.error('Error fetching data:', error);
    return reply.view("/src/pages/error.hbs",
{ error: 'Error fetching event data' });
}
});
fastify.post("/update-opt-in/:recordId", async (request, reply) => {
  const { recordId } = request.params;
  const updatedData = request.body; // Data to update

  try {
    // Combine firstName and lastName into a single Full Name field
    const fullName = `${updatedData.firstName} ${updatedData.lastName}`;

    // Use the Airtable API to update the record in the MASTER table
    const record = await base("MASTER").update(recordId, {
      "Full Name": fullName, // Update Full Name field
      "Phone": updatedData.phone,
      "Email": updatedData.email,
      "Attended Opportunity Night": true, // Assuming this is a checkbox field
      "Opt In": true, // Set Opt In field to true
      "Status": "Opted In", // Set Status to Opted In
      "Office Record": [updatedData.eventLocation],
      'Qualifier 1': updatedData.insuranceApprovedDrivingRecord,
      'Qualifier 2': updatedData.carInsurance,
      'Qualifier 3': updatedData.reliableTransportation,
      'Qualifier 4': updatedData.driversLicense,
    });

    return reply.send({ success: true, message: "Record updated successfully" });
  } catch (error) {
    console.error("Error updating record:", error);
    return reply.status(500).send({ success: false, message: "Error updating record" });
  }
});
fastify.post("/create-update-opt-in-record", async (request, reply) => {
  const requestData = request.body; // Data to create or update the record

  try {
    // Combine firstName and lastName into a single Full Name field
    const fullName = `${requestData.firstName} ${requestData.lastName}`;

    // Check if the record already exists based on the email
    const existingRecord = await base("MASTER")
      .select({
        maxRecords: 1,
        filterByFormula: `{Email} = '${requestData.email}'`, // Use email as the filter
      })
      .firstPage();

    if (existingRecord && existingRecord.length > 0) {
      // If the record exists, update it
      const recordId = existingRecord[0].id;
      await base("MASTER").update(recordId, {
        "Full Name": fullName,
        "Phone": requestData.phone,
        "Email": requestData.email,
        "Status": "Registered At Opportunity Night", // Set the Status field to "Opted In"
        "Attended Opportunity Night": true,
        "Attended Opportunity Night Event Record": [requestData.eventId], // Add eventId to the field
        "Office Record": [requestData.eventLocation], // Add eventLocation to the field
      });
      return reply.send({ success: true, message: "Record updated successfully" });
    } else {
      // If the record doesn't exist, create a new one
      await base("MASTER").create([
        {
          fields: {
            "Full Name": fullName,
            "Phone": requestData.phone,
            "Email": requestData.email,
            "Status": "Registered At Opportunity Night", // Set the Status field to "Opted In"
            "Attended Opportunity Night": true,
            "Attended Opportunity Night Event Record": [requestData.eventId], // Add eventId to the field
            "Office Record": [requestData.eventLocation],
            // Add eventLocation to the field
          },
        },
      ]);
      return reply.send({ success: true, message: "Record created successfully" });
    }
  } catch (error) {
    console.error("Error creating/updating record:", error);
    return reply.status(500).send({ success: false, message: "Error creating/updating record" });
  }
});


fastify.get("/office/:officeId", async (request, reply) => {
  const officeId = request.params.officeId;
  let candidatesData = [];
  let officeName = "";
  let officeAddress = "";
  let timeZone = "";
  let officeIcon = "";
  let paylocityApplicationLink = "";
  let statuses = new Set(); // Use a Set to collect unique statuses
  
 function formatDate(dateString) {
    if (!dateString) return ''; // Return empty string if dateString is null, undefined, or empty
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return ''; // Return empty string if date is invalid
    
    const month = date.toLocaleString('default', { month: 'short' });
    const day = date.getDate();
    const year = date.getFullYear();
    const suffix = ['th', 'st', 'nd', 'rd'][(day % 10 > 3) ? 0 : (day % 100 - day % 10 != 10) * day % 10];
    return `${month} ${day}${suffix}, ${year}`;
  }

  try {
    // Fetch the office data from 'Office Locations' table
    const officeData = await base('Office Locations').find(officeId);
    officeName = officeData.fields['Name'];
    officeIcon = officeData.fields['Office Icon URL'];
    officeAddress = officeData.fields['Address'];
    timeZone = officeData.fields['Time Zone'];
    paylocityApplicationLink = officeData.fields['Paylocity Application Link']; // Get the Paylocity Application Link
    const candidateIds = officeData.fields['Candidates'];

    // Fetch candidate details that meet the criteria from 'MASTER' table
    const allQualifiedCandidates = await base('MASTER').select({
      filterByFormula: "AND({Opt In} = TRUE(), {Disqualified} = FALSE(), {Hired} = FALSE())"
    }).all();

    // Filter the qualified candidates by the list of candidate IDs from the office
    candidatesData = allQualifiedCandidates.filter(candidate => 
      candidateIds.includes(candidate.id)
    ).map(record => {
      const status = record.get('Status');
      statuses.add(status); // Collect the status
      return {
        firstName: record.get('First Name'),
        lastName: record.get('Last Name'),
        phone: record.get('Phone'),
        email: record.get('Email'),
        attended: record.get('Attended Opportunity Night'),
        recordId: record.id,
        onboardingForm: record.get('Onboarding Request Form Link'),
        status: status,
        leaderEmail: record.get('Opportunity Night Leader Email'),
        leaderName: record.get('Opportunity Night Leader Name'),
        leaderPhone: record.get('Opportunity Night Leader Phone'),
        virtualInterview: record.get('Video Interview Share Link'),
        questionnaireKey: record.get('Questionnaire Score Key'),
        notes: record.get('Notes'),
        dateApplied: formatDate(record.get('Date Applied')),
      };
    });

    // Convert statuses Set to an array
    const statusesArray = Array.from(statuses);

    // Render the HTML page with candidate data, office data, and statuses
    return reply.view("/src/pages/office.hbs", { 
      candidates: candidatesData, 
      uniqueStatuses: statusesArray, 
      officeId, 
      officeName, 
      officeAddress, 
      timeZone, 
      officeIcon,
      paylocityApplicationLink // Pass the Paylocity Application Link to the view
    });
  } catch (error) {
    console.error('Error fetching data:', error);
    return reply.view("/src/pages/error.hbs", { error: 'Error fetching office data' });
  }
});



fastify.get("/api/getOfficeRecords", async (request, reply) => {
  try {
    // Fetch the Name, Address, and Time Zone from 'Office Locations' table
    const officeRecords = await base('Office Locations').select({
      fields: ['Name', 'Address', 'Time Zone'],
    }).all();

    // Send the officeRecords data as JSON response
    return reply.send({ officeRecords });
  } catch (error) {
    console.error('Error fetching officeRecords:', error);
    return reply.status(500).send({ error: 'Error fetching officeRecords' });
  }
});
fastify.post("/submitInterviewDetails", async (request, reply) => {
    const { leaderEmail, email, location, timeZone, dateTime, candidateName, leaderName, candidatePhone, leaderPhone, recordId } = request.body;

    try {
        console.log("Received Data:", { leaderEmail, email, location, timeZone, dateTime, recordId });

        // Parse the dateTime in the original time zone
        let momentDateTime = moment.tz(dateTime, timeZone);
        console.log("Moment Time (Original Time Zone):", momentDateTime.format());

        // Convert the dateTime to America/Denver time zone
        let convertedDateTime = momentDateTime.tz('America/Denver').format();
        console.log("Converted Time (America/Denver):", convertedDateTime);

        // Construct the payload with the converted dateTime
        const payload = {
            leaderEmail,
            leaderName,
            candidateName,
            candidatePhone,
            leaderPhone,
            candidateEmail: email,
            location,
            dateTime: convertedDateTime, // Use the converted dateTime
            timeZone: timeZone,
            recordId,
        };

        console.log("Payload to be sent:", payload);

        // Specify the webhook URL
        const webhookUrl = 'https://hook.us1.make.com/fpcfbbxpd32jgiociof81t8fwuwsumfj';

        // Send the data to the webhook
        const webhookResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Check the response from the webhook
        if (webhookResponse.ok) {
            console.log("Webhook Response OK");
            return reply.send({ success: true, message: 'Interview details submitted successfully.' });
        } else {
            const errorBody = await webhookResponse.json();
            console.error('Webhook responded with an error:', errorBody);
            return reply.status(webhookResponse.status).send({ success: false, message: 'Error in submitting interview details.', details: errorBody });
        }
    } catch (error) {
        console.error('Error in /submitInterviewDetails:', error);
        return reply.status(500).send({ error: 'Server error', details: error.message });
    }
});
fastify.post("/updateCandidateStatus", async (request, reply) => {
    try {
        const { recordId, updatedFields, timeZone } = request.body;

        // Convert the dateTime to the provided time zone
        if (updatedFields["First Interview Date"] && timeZone) {
            const convertedDateTime = moment.tz(updatedFields["First Interview Date"], timeZone).format();
            updatedFields["First Interview Date"] = convertedDateTime;
        }

        const updateResult = await updateAirtableRecord(recordId, updatedFields);
        return reply.send({ success: true, data: updateResult });
    } catch (error) {
        console.error('Error updating record:', error);
        return reply.status(500).send({ success: false, message: 'Error updating record', details: error.message });
    }
});
fastify.post("/disqualify-candidate", async (request, reply) => {
    const { reason, recordId } = request.body;

    try {
        await updateAirtableRecord(recordId, {
            "Reason For Disqualification": reason,
            "Disqualified": true,
            "Status": "Thanks But No Thanks"
        });

        return reply.send({ success: true, message: "Candidate status updated successfully." });
    } catch (error) {
        console.error("Error updating candidate status:", error);
        return reply.status(500).send({ success: false, message: "Error updating candidate status", details: error.message });
    }
});
fastify.get('/interview/:recordId', async (request, reply) => {
    const { recordId } = request.params;

    try {
        const record = await base('MASTER').find(recordId);
        const firstName = record.get('First Name');
        const lastName = record.get('Last Name');

        // Generate today's date in a friendly format
        const today = new Date();
        const options = { year: 'numeric', month: 'long', day: 'numeric' }; // Customize as needed
        const friendlyDate = today.toLocaleDateString('en-US', options); // Adjust locale as needed

        // Pass the friendly date along with other data to the template
        return reply.view('/src/pages/interview.hbs', {
            firstName,
            lastName,
            recordId,
            friendlyDate // Include the friendly date in the template context
        });
    } catch (error) {
        console.error('Error fetching record:', error);
        return reply.view('/src/pages/error.hbs', {
            error: 'Error fetching record data'
        });
    }
});
fastify.post('/submit-interview/:recordId', async (request, reply) => {
    const { recordId } = request.params;
    console.log('Received recordId:', recordId);
  
    const formData = request.body;
    console.log('Received form data:', formData);

    // Get the current date in the desired format
    const currentDate = new Date().toISOString().split('T')[0]; // Formats the date as "YYYY-MM-DD"

    const airtableData = {
        '1st Interview - Q1': formData.question1,
        '1st Interview - Q2': formData.question2,
        '1st Interview - Q3': formData.question3,
        '1st Interview - Q4': formData.question4,
        '1st Interview - Q5': formData.question5,
        '1st Interview - Q6': formData.question6,
        '1st Interview - Q7': formData.question7,
        '1st Interview - Q8': formData.question8,
        '1st Interview - Q9': formData.question9,
        '1st Interview - Q10': formData.question10,
        '1st Interview - Q11': formData.question11,
        '1st Interview - Q12': formData.question12,
        '1st Interview - Q13': formData.question13,
        'Qualifier 1': formData.insuranceApprovedDrivingRecord,
        'Qualifier 2': formData.carInsurance,
        'Qualifier 3': formData.reliableTransportation,
        'Qualifier 4': formData.driversLicense,
        'First Interview Date': currentDate, // Add the current date
        '1st Interview Completed': true, // Mark the interview as complete
        'Status': '1st Interview Complete' // Update the status
    };

        console.log('Updating recordId:', recordId);
        console.log('With data:', airtableData);

    try {
        await updateAirtableRecord(recordId, airtableData); // Use the updateAirtableRecord function
        return reply.redirect('/submission-success');
    } catch (error) {
        console.error('Error updating Airtable record:', error);
        return reply.view('/src/pages/error.hbs', { error: 'Error submitting interview form' });
    }
});
// Handle /submission-success route
fastify.get('/submission-success', async (request, reply) => {
    try {
        // Render the submission-success template
        return reply.view('/src/pages/submission-success.hbs');
    } catch (error) {
        console.error('Error rendering submission success page:', error);
        // Render an error page if there's an error
        return reply.view('/src/pages/error.hbs', { error: 'Error rendering submission success page' });
    }
});
fastify.post('/update-qualifiers/:recordId', async (request, reply) => {
    const { recordId } = request.params; // Get the record ID from the URL parameter
    const formData = request.body; // Get the submitted form data from the request body

    // Extract the qualifier data from the form data
    const qualifierData = {
        'Qualifier 1': formData.insuranceApprovedDrivingRecord,
        'Qualifier 2': formData.carInsurance,
        'Qualifier 3': formData.reliableTransportation,
        'Qualifier 4': formData.driversLicense,
    };

    try {
        // Use the updateAirtableRecord function to update the record with the qualifier data
        await updateAirtableRecord(recordId, qualifierData);
        // If the update is successful, redirect the user or send a success message
        return reply.redirect('/submission-success'); // Adjust the redirect URL as needed
    } catch (error) {
        // Log the error and return an error message or view
        console.error('Error updating Airtable record with qualifiers:', error);
        return reply.view('/src/pages/error.hbs', { error: 'Error updating qualifiers' });
    }
});
fastify.get('/outcome/:recordId', async (request, reply) => {
    const { recordId } = request.params; // Extract recordId from the URL parameter

    try {
        // Fetch the record from the MASTER table using the recordId
        const record = await base('MASTER').find(recordId);

        // Extract fields from the record, if they exist
        const firstName = record.get('First Name') || '';
        const lastName = record.get('Last Name') || '';
        const email = record.get('Email') || '';
        const hiringManagerEmail = record.get('Hiring Manager Email') || '';
        const timeZone = record.get('Time Zone') || '';// Adjust field name as necessary

      console.log("Data being passed to the template:", { firstName, lastName, email, hiringManagerEmail, recordId });
        // Pass the potentially available data to the interview-outcome.hbs template
        // Handlebars on the client side can handle missing fields gracefully
        return reply.view('/src/pages/interview-outcome.hbs', {
            firstName, // Could be empty string if not present
            lastName, // Could be empty string if not present
            email, // Could be empty string if not present
            hiringManagerEmail, // Could be empty string if not present
            recordId,
            timeZone
        });

    } catch (error) {
        console.error('Error fetching record:', error);
        // Render an error page or return a suitable error response
        return reply.view('/src/pages/error.hbs', {
            error: 'Error fetching record data'
        });
    }
});

fastify.post('/schedule-offer-call', async (request, reply) => {
    const { recordId, candidateEmail, hiringManagerEmail, dateTime, timeZone } = request.body;

    // Convert dateTime from the original timeZone to "America/Denver"
    const momentDateTime = moment.tz(dateTime, timeZone);
    const denverDateTime = momentDateTime.tz('America/Denver').format();

    // Prepare the payload for the webhook
    const payload = {
        recordId,
        candidateEmail,
        hiringManagerEmail,
        timeZone,
        dateTime,
        denverDateTime: denverDateTime
    };

    try {
        // Send the data to the webhook
        const webhookResponse = await fetch('https://hook.us1.make.com/k6r1bibdme3omvj0kboh6pcl5f14u2aj', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (webhookResponse.ok) {
            return reply.send({ success: true, message: 'Interview scheduled successfully.' });
        } else {
            // Handle errors from the webhook response
            console.error('Webhook error:', await webhookResponse.text());
            return reply.code(500).send({ success: false, message: 'Failed to schedule interview.' });
        }
    } catch (error) {
        console.error('Server error:', error);
        return reply.code(500).send({ success: false, message: 'Server error while scheduling interview.' });
    }
});
fastify.get('/offer/:recordId', async (request, reply) => {
    const { recordId } = request.params; // Extract recordId from the URL parameter

    try {
        // Fetch the record from the MASTER table using the recordId
        const record = await base('MASTER').find(recordId);

        // Extract fields from the record, if they exist
        const fullName = `${record.get('First Name') || ''} ${record.get('Last Name') || ''}`;
        const status = record.get('Status') || '';
        const email = record.get('Email') || '';
        const phone = record.get('Phone') || '';
        const onboardingForm = record.get('Onboarding Request Form Link') || '';
        const paylocityApplication = record.get('Paylocity Application') || '';
        const firstName = record.get('First Name') || '';
        const onboardForm = record.get('Onboarding Request Form Link') || '';
        const managerEmail = record.get('Hiring Manager Email') || '';
        const timeZone = record.get('Time Zone') || '';
        // Add any other fields you need
        const location = record.get('Office Address') || '';
        
                // Add "Phone Call" and "See Notes" to the options array
        location.push("Phone Call");
        location.push("See Notes");
        // Prepare the data to be passed to the template
        const templateData = {
            fullName,
            status,
            email,
            phone,
            onboardingForm,
            recordId,
            paylocityApplication,
            firstName,
            onboardForm,
            managerEmail,
            location,
            timeZone,
            // Include any additional data you need in the template
        };

        // Render the offer-call.hbs template with the data
        return reply.view('/src/pages/offer-call.hbs', templateData);
    } catch (error) {
        console.error('Error fetching record:', error);
        // Render an error page or return a suitable error response
        return reply.view('/src/pages/error.hbs', {
            error: 'Error fetching candidate data'
        });
    }
});
fastify.post('/schedule-onboarding-day', async (request, reply) => {
    const data = request.body; // This should be adjusted to how you're actually parsing form data.

        // Parse the time as being in the specified timezone
    const localTime = moment.tz(data.dateTime, data.hiddenTimeZone);

    // If you need to format it in a specific way or convert it to another timezone
    const formattedTime = localTime.format(); // This will keep it in the original timezone but formatted
    // Or, to convert to another timezone, e.g., America/Denver:
    const denverTime = localTime.clone().tz('America/Denver').format();

  
    const payload = {
        leaderEmail: data.hiringManagerEmail,
        email: data.candidateEmail,
        location: data.location,
        denverTime: denverTime,
        notes: data.meetingNotes,
        candidateName: data.hiddenCandidateName,
        leaderName: data.hiddenLeaderName,
        leaderPhone: data.hiddenLeaderPhone,
        candidatePhone: data.hiddenCandidatePhone,
        recordId: data.hiddenRecordId,
        timeZone: data.hiddenTimeZone,
        dateTime: data.dateTime,
    };

    try {
        const webhookUrl = 'https://hook.us1.make.com/ci95d6ilq28953d5y11fewrnb1jhsipl';
        const webhookResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (webhookResponse.ok) {
    const contentType = webhookResponse.headers.get("Content-Type");
    if (contentType && contentType.includes("application/json")) {
        const responseBody = await webhookResponse.json(); // This line assumes the response is JSON
        return reply.send({ success: true, message: 'Onboarding details submitted successfully.', data: responseBody });
    } else {
        const responseText = await webhookResponse.text(); // Fallback to reading response as text
        console.log("Non-JSON response from webhook:", responseText);
        return reply.send({ success: true, message: 'Onboarding details submitted successfully, but received non-JSON response.', data: responseText });
    }
} else {
    throw new Error(`Webhook responded with status: ${webhookResponse.status}`);
}

    } catch (error) {
        console.error('Error sending data to webhook:', error);
        return reply.code(500).send({ success: false, message: 'Server error while sending data to webhook.', details: error.message });
    }
});

// Our application form page route
fastify.get('/apply', async (request, reply) => {
    try {
        const officeRecords = await base('Office Locations').select({
            fields: ['Name', 'Fast Track Application'] // Ensure 'Fast Track Application' is included
        }).all();

        // Filter office records to include only those with names containing a comma
        const filteredRecords = officeRecords.filter(record => record.fields.Name.includes(','));

        // Include names, IDs, and Fast Track Application URLs in the officeData
        const officeData = filteredRecords.map(record => ({
            name: record.fields.Name,
            id: record.id,
            fastTrackApplication: record.fields['Fast Track Application'] // Include the URL
        }));

        console.log('Office Data:', officeData); // Debugging: log office data

        return reply.view('/src/pages/apply.hbs', { officeData });
    } catch (error) {
        console.error('Error fetching office data:', error);
        reply.status(500).send({ error: 'Failed to fetch office data' });
    }
});



fastify.get('/virtualapply', async (request, reply) => {
    try {
        const officeRecords = await base('Office Locations').select({
            fields: ['Name'] // Assuming 'Name' is the field that contains the office names
        }).all();

        // Include both names and IDs in the officeData
        const officeData = officeRecords.map(record => ({
            name: record.fields.Name,
            id: record.id
        }));

        return reply.view('/src/pages/virtualapply.hbs', { officeData });
    } catch (error) {
        console.error('Error fetching office data:', error);
        // Handle error
    }
});

fastify.get('/virtualinterview', async (request, reply) => {
     try {
        const officeRecords = await base('Office Locations').select({
            fields: ['Name'] // Assuming 'Name' is the field that contains the office names
        }).all();

        // Filter office records to include only those with names containing a comma
        const filteredRecords = officeRecords.filter(record => record.fields.Name.includes(','));

        // Include both names and IDs in the officeData
        const officeData = filteredRecords.map(record => ({
            name: record.fields.Name,
            id: record.id
        }));

        return reply.view('/src/pages/virtualinterview.hbs', { officeData });
    } catch (error) {
        console.error('Error fetching office data:', error);
        // Handle error
    }
});

fastify.post('/applyform', async (request, reply) => {
    // Destructure the request body and immediately trim the values
    const {
        firstName,
        lastName,
        email,
        phone,
        officeRecord,
        utmSource,
        utmMedium,
        utmCampaign
    } = request.body;

    // Trim the values to ensure no accidental spaces are processed
    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    const trimmedOfficeRecord = officeRecord.trim();
    const trimmedUtmSource = utmSource.trim();
    const trimmedUtmMedium = utmMedium.trim();
    const trimmedUtmCampaign = utmCampaign.trim();

    const fullName = `${trimmedFirstName} ${trimmedLastName}`;

    try {
        // Search for existing records by email or phone number
        const existingRecords = await base('MASTER').select({
            filterByFormula: `OR({Email} = '${trimmedEmail}', {Phone} = '${trimmedPhone}')`,
            maxRecords: 1
        }).firstPage();

        if (existingRecords.length > 0) {
            // If a record exists, update it
            const recordId = existingRecords[0].id;
            const updatedRecord = await base('MASTER').update(recordId, {
                'Full Name': fullName,
                'Email': trimmedEmail,
                'Phone': trimmedPhone,
                'Status': 'Requesting Interview',
                'Office Record': [trimmedOfficeRecord], // Assuming this is an array of IDs
                'utmSource': trimmedUtmSource,
                'utmMedium': trimmedUtmMedium,
                'utmCampaign': trimmedUtmCampaign,
                'Opt In': true,
            });

            return reply.send({ success: true, message: 'Application updated successfully.', record: updatedRecord });
        } else {
            // If no record exists, create a new one
            const createdRecord = await base('MASTER').create([{
                fields: {
                    'Full Name': fullName,
                    'Email': trimmedEmail,
                    'Phone': trimmedPhone,
                    'Status': 'Requesting Interview',
                    'Office Record': [trimmedOfficeRecord], // Assuming this is an array of IDs
                    'utmSource': trimmedUtmSource,
                    'utmMedium': trimmedUtmMedium,
                    'utmCampaign': trimmedUtmCampaign,
                    'Opt In': true,
                }
            }]);

            return reply.send({ success: true, message: 'Application submitted successfully.', record: createdRecord });
        }
    } catch (error) {
        console.error('Error creating/updating record:', error);
        return reply.status(500).send({ success: false, message: 'Failed to submit application.' });
    }
});


fastify.post('/virtualapplyform', async (request, reply) => {
    // Destructure the request body and immediately trim the values
    const {
        firstName,
        lastName,
        email,
        phone,
        officeRecord,
        utmSource,
        utmMedium,
        utmCampaign
    } = request.body;

    // Trim the values to ensure no accidental spaces are processed
    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    const trimmedOfficeRecord = officeRecord.trim();
    const trimmedUtmSource = utmSource.trim();
    const trimmedUtmMedium = utmMedium.trim();
    const trimmedUtmCampaign = utmCampaign.trim();

    const fullName = `${trimmedFirstName} ${trimmedLastName}`;

    try {
        // Create a new record in the MASTER table with the trimmed values
        const createdRecord = await base('MASTER').create([{
            fields: {
                'Full Name': fullName,
                'Email': trimmedEmail,
                'Phone': trimmedPhone,
                'Status': 'Virtual Op Night Apply',
                'Office Record': [trimmedOfficeRecord], // Assuming this is an array of IDs
                'utmSource': trimmedUtmSource,
                'utmMedium': trimmedUtmMedium,
                'utmCampaign': trimmedUtmCampaign,
                'Opt In': true,
            }
        }]);

        return reply.send({ success: true, message: 'Application submitted successfully.', record: createdRecord });
    } catch (error) {
        console.error('Error creating record:', error);
        return reply.status(500).send({ success: false, message: 'Failed to submit application.' });
    }
});


fastify.get('/requesthire', async (request, reply) => {
    try {
      
       // Get the officeId from the query parameters
        const officeId = request.query.officeId || '';
      
        // Fetch team members
        const teamMembers = await fetchTeamMembers({
        roleNot: 'TERM',
        roleType: 'Manager',
    });

        // Prepare data to pass to your template, structured as needed
        const data = {
            teamMembers,
            officeId,
            // any other data you want to pass
        };

        // Render the template with the fetched data
        return reply.view('/src/pages/request-to-hire.hbs', data);
    } catch (error) {
        fastify.log.error(error);
        return reply.send({ error: error.message });
    }
});


fastify.get('/requesthire/:recordId', async (request, reply) => {
    const { recordId } = request.params;
    const { officeId } = request.query;

    try {
        // Fetch the specific record by ID from the 'MASTER' table
        const record = await base('MASTER').find(recordId);

        // Extract required fields from the record
        const recordDetails = {
            firstName: record.get('First Name'),
            lastName: record.get('Last Name'),
            phone: record.get('Phone'),
            email: record.get('Email'),
            recordId: record.get('recordId'),
            referral: record.get('Referral'),
            showReferral: record.get('Referral') === true,
            indeedApply: record.get('Indeed Apply')
        };

        // Render the Handlebars template with the record details
        return reply.view('/src/pages/request-to-hire.hbs', { record: recordDetails, officeId: officeId });
    } catch (error) {
        console.error('Error fetching record:', error);
        return reply.view('/src/pages/error.hbs', { error: 'Error fetching record data' });
    }
});


fastify.get('/teammembers', async (request, reply) => {
    try {
        // Fetch team members
        const teamMembers = await fetchTeamMembers();
        // Simply return the team members data as JSON
        return reply.send({ teamMembers });
    } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: error.message });
    }
});
fastify.get('/teams', async (request, reply) => {
    try {
        const teams = await fetchTeams();
        return reply.send({ teams });
    } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: error.message });
    }
});
fastify.get('/roles', async (request, reply) => {
    try {
        const roles = await fetchRoles();
        return reply.send({ roles });
    } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: error.message });
    }
});

fastify.get('/payscales', async (request, reply) => {
    try {
        const payscales = await fetchPayscales();
        return reply.send({ payscales });
    } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: error.message });
    }
});



fastify.post('/request-hire-submission', async (request, reply) => {

try {
    const response = await fetch('https://hook.us1.make.com/ybqngua7sfufpxo3tpxtgreoyw0tzdop', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(request.body),
    });

    if (!response.ok) {
        throw new Error(`Failed to send data to the webhook. Status: ${response.status}`);
    }

    // Read response body as text first
    const responseBodyText = await response.text();

    let responseData;
    try {
        // Attempt to parse the text as JSON
        responseData = JSON.parse(responseBodyText);
    } catch (error) {
        // If parsing fails, use the text directly
        console.warn('Webhook responded with non-JSON data:', responseBodyText);
        responseData = { message: responseBodyText };
    }
    
    // Respond back to the original client if needed
    return reply.code(200).send({ success: true, data: responseData });
} catch (error) {
    console.error('Error sending data to the webhook:', error);
    return reply.code(500).send({ success: false, error: error.message });
}

});


fastify.post('/newhire-communication', async (request, reply) => {
    // The form data will be available in request.body
    // Now forward this data to the webhook

try {
    const response = await fetch('https://hook.us1.make.com/2isjwinn9o31bulloeykstvlk84nyktf', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(request.body),
    });

    if (!response.ok) {
        throw new Error(`Failed to send data to the webhook. Status: ${response.status}`);
    }

    // Read response body as text first
    const responseBodyText = await response.text();

    let responseData;
    try {
        // Attempt to parse the text as JSON
        responseData = JSON.parse(responseBodyText);
    } catch (error) {
        // If parsing fails, use the text directly
        console.warn('Webhook responded with non-JSON data:', responseBodyText);
        responseData = { message: responseBodyText };
    }
    
    // Respond back to the original client if needed
    return reply.code(200).send({ success: true, data: responseData });
} catch (error) {
    console.error('Error sending data to the webhook:', error);
    return reply.code(500).send({ success: false, error: error.message });
}

});




fastify.post('/add-candidate-airtable', async (request, reply) => {
    try {
        const { firstName, lastName, email, phoneNumber, officeId, referredBy } = request.body; // Add referredBy to the destructured variables

        // Construct the Full Name by combining First Name and Last Name
        const fullName = `${firstName} ${lastName}`;

        // Prepare the data object for Airtable, including referral logic
        const data = {
            "Full Name": fullName,
            "Email": email,
            "Phone": phoneNumber,
            "Office Record": [officeId], // Assuming officeId is a string and "Office Record" expects an array of IDs
            "Status": "Manual Input",
            "Opt In": true
        };

        // Check if the referredBy field is filled out
        if (referredBy && referredBy.trim() !== '') {
            data["Referral"] = true; // Set Referral to true
            data["Referred By"] = referredBy; // Add the Referred By information
        } else {
            data["Referral"] = false; // Optionally set Referral to false if not referred
        }

        // Use the createRecord function to add the new record
        const record = await createRecord("MASTER", data);

        // Sending a success response back to the client
        reply.code(200).send({
            status: 'success',
            message: 'Record added successfully',
            recordId: record.getId()
        });
    } catch (error) {
        console.error('Error in /add-candidate-airtable:', error);
        // Sending an error response back to the client
        reply.code(500).send({
            status: 'error',
            message: 'Failed to add new record',
            error: error.message
        });
    }
});

fastify.get('/requesthire-success', async (request, reply) => {
  // Render the template located at `src/pages/requesthire-success.hbs`
  return reply.view('/src/pages/requesthire-success.hbs', {
    // You can pass any local variables you might need in your template here
    title: 'Request Hire Success'
  });
});

// Define the new endpoint
fastify.get('/requesthire-success/:teamId', async (request, reply) => {
    const { teamId } = request.params;

    try {
        // Query the Team table in baseSecond to find the team record with the matching teamId
        const teamRecords = await baseSecond('Team').select({
            filterByFormula: `{teamId} = '${teamId}'`
        }).firstPage();

        if (teamRecords.length === 0) {
            // No team found with the given teamId
            throw new Error('Team not found');
        }

        const teamRecord = teamRecords[0];
        const paylocityApplicationLink = teamRecord.fields['Paylocity Application Link'];

        // Render the requesthire-success.hbs template with the URL
        return reply.view('/src/pages/requesthire-success.hbs', { paylocityApplicationLink });
    } catch (error) {
        console.error('Error fetching team data:', error);
        return reply.view('/src/pages/error.hbs', { error: 'Failed to retrieve team data' });
    }
});



// Endpoint to get the onboarding status of candidates based on officeId
// Endpoint to get the onboarding status of candidates based on officeId
fastify.get('/status/:officeId', async (request, reply) => {
    try {
        const { officeId } = request.params;
        // Retrieve the office record by officeId
        const officeRecords = await base('Office Locations').select({
            filterByFormula: `{officeId} = '${officeId}'`
        }).firstPage();
        if (officeRecords.length === 0) {
            // No office found with the given officeId
            throw new Error('Office not found');
        }
        const candidatesIds = officeRecords[0].get('Candidates');
        if (!candidatesIds) {
            // No candidates linked to this office
            return reply.view('/src/pages/onboarding-status.hbs', { error: 'No candidates found for this office.' });
        }
        // Array to hold the candidates' information
        const candidatesInfo = [];
        // Define the date range for filtering
        const twoWeeksAgo = moment().subtract(2, 'weeks');
        const oneMonthFromNow = moment().add(1, 'month');
        // Use "Offered" view to fetch only relevant records
        const records = await base('MASTER').select({
            view: "Offered",
            filterByFormula: `AND(IS_AFTER({Start Date}, '${twoWeeksAgo.format('YYYY-MM-DD')}'), IS_BEFORE({Start Date}, '${oneMonthFromNow.format('YYYY-MM-DD')}'))`
        }).all();
        // Filter candidates by their ID in the pre-fetched records
        records.forEach(record => {
            // Add check for Disqualified field
            if (candidatesIds.includes(record.id) && !record.get('Disqualified')) {
                const formattedStartDate = moment(record.get('Start Date')).format('MMMM DD, YYYY');
              
                const allConditionsTrue = record.get('Background Check Authorized') &&
                          record.get('Background Check Complete') &&
                          record.get('Candidate Packet Complete') &&
                          record.get('Onboarding Initiated') &&
                          record.get('Onboarding Packet Complete') &&
                          record.get('HR Packet Complete');
                
                const startDateMoment = moment(record.get('Start Date'));
                const today = moment();
                const daysUntilStartDate = startDateMoment.diff(today, 'days');
                candidatesInfo.push({
                    fullName: record.get('Full Name'),
                    startDate: formattedStartDate,
                    backgroundCheckAuthorized: record.get('Background Check Authorized'),
                    backgroundCheckComplete: record.get('Background Check Complete'),
                    candidatePacketComplete: record.get('Candidate Packet Complete'),
                    onboardingInitiated: record.get('Onboarding Initiated'),
                    onboardingPacketComplete: record.get('Onboarding Packet Complete'),
                    hrPacketComplete: record.get('HR Packet Complete'),
                    backgroundCheckUnderReview: record.get('Background Check Under Review'),
                    allConditionsTrue: allConditionsTrue,
                    daysUntilStart: daysUntilStartDate >= 0 ? daysUntilStartDate : 0,
                });
            }
        });
        
        candidatesInfo.sort((a, b) => {
            // Convert start dates from formatted strings back to moments
            let dateA = moment(a.startDate, 'MMMM DD, YYYY');
            let dateB = moment(b.startDate, 'MMMM DD, YYYY');
            return dateA.diff(dateB); // This will sort in ascending order
        });
        // Render the Handlebars template with the candidates' information
        return reply.view('/src/pages/onboarding-status.hbs', { candidates: candidatesInfo });
    } catch (error) {
        console.error('Error processing request:', error);
        return reply.view('/src/pages/error.hbs', { error: 'Failed to retrieve onboarding status' });
    }
});
fastify.post('/freshservice-onboarding-request', async (request, reply) => {
  const data = request.body; // Assuming body-parser is enabled

  // Transform the data into the format expected by the webhook
  const payload = {
    FirstName: data.legalFirstName,
    LastName: data.lastName,
    JobTitleID: data.roleInfo.freshserviceId,
    DepartmentID: data.roleInfo.freshserviceDepartment,
    ImmediateManagerID: data.immediateSupervisorInfo.freshserviceId,
    PhoneNumber: data.phone,
    StartDate: new Date(data.startDate).toISOString(),
    SalesOfficeLocation: "N/A",
    LocationID: data.teamInfo.freshserviceLocationId,
    ExtraNotes: data.notes,
    SalesforceNewUser: "Yes",
    SalesforcePLResource: "No",
    TShirtSize: data.shirtSize,
    ApparelNeededDate: new Date(data.startDate).toISOString(),
    SubmittedByEmail: data.hiringManagerInfo.email,
    ImmediateManagerEmail: data.immediateSupervisorInfo.email,
    EnergyConsultantSalesManager: data.roleInfo.EnergyConsultantSalesManager,
    LoanPortalAccess: data.roleInfo.LoanPortalAccess,
    EmployeePersonalEmail: data.email,
  };

  // Send the data to the webhook
  try {
    const response = await fetch('https://webhooks.workato.com/webhooks/rest/c1e3be47-2099-4e68-b73f-1e7d48994570/fresh-service-onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // You can process the response further if needed
    const responseBody = await response.json();

    // Reply with a success message or the response body
    reply.send({ success: true, message: 'Data sent to webhook successfully', responseBody });
  } catch (error) {
    fastify.log.error(error);
    reply.send({ success: false, message: 'Failed to send data to webhook', error: error.message });
  }
});


fastify.get('/rsvplist/:officeId', async (request, reply) => {
    const officeId = request.params.officeId;

    try {
        const candidates = await base('MASTER').select({
            view: "Upcoming RSVP List"
        }).all();

        const filteredCandidates = candidates.filter(candidate => {
            const officeRecords = candidate.get('Office Record'); // Assuming this returns an array of IDs
            return officeRecords.includes(officeId);
        });

        const formattedCandidates = filteredCandidates.map(candidate => {
            const opNightDateISO = candidate.get('Opportunity Night Date');
            // Corrected to use `moment` instead of `moments`
            const opNightDate = moment(opNightDateISO, 'YYYY-MM-DDTHH:mm:ss.SSSZ').format('MMMM D, YYYY');


            return {
                fullName: candidate.get('Full Name'),
                phone: candidate.get('Phone'),
                opNightDate, // Now correctly formatted
                firstName: candidate.get('First Name'),
            };
        });

        return reply.view('src/pages/rsvp-list.hbs', { candidates: formattedCandidates });
    } catch (error) {
        console.error('Error fetching RSVP list:', error);
        return reply.status(500).send({ error: 'Failed to retrieve RSVP list' });
    }
});

// Function to register a user for a Demio event
async function registerForDemioEvent(firstName, lastName, email, phone, dateId, utmId, utmSource, utmMedium, utmCampaign) {
    const url = `https://my.demio.com/api/v1/event/register`;
    const headers = {
        'Content-Type': 'application/json',
        'Api-Key': process.env.DEMIO_API_KEY,
        'Api-Secret': process.env.DEMIO_API_SECRET
    };
    const body = {
        id: 829792, // Event ID, null as per provided examples
        ref_url: null, // Event Registration page URL, null as per provided examples
        date_id: dateId, // Event Date ID
        name: firstName, // Required field
        email: email, // Required field
        last_name: lastName, // Optional, provided
        phone_number: phone, // Optional, provided
        custom_field: {
            'de26170a-a39b-4717-a59c-613c62d74091': utmId // Populate custom field with UTM ID
        }
    };

    console.log('Request Body:', body); // Log the request body to see the payload

    try {
        const response = await fetch(url, {
            method: 'PUT',
            headers: headers,
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`HTTP error! status: ${response.status} - ${errorBody}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error registering for Demio event:', error);
        throw error;
    }
}

// Route to handle the registration
fastify.post('/register-for-demio', async (request, reply) => {
    const { firstName, lastName, email, phone, event: dateId, utmId, utmSource, utmMedium, utmCampaign } = request.body;
    try {
        const registrationData = await registerForDemioEvent(firstName, lastName, email, phone, dateId, utmId, utmSource, utmMedium, utmCampaign);
        reply.send({ success: true, data: registrationData });
    } catch (error) {
        reply.status(500).send({ success: false, error: 'Failed to register for Demio event' });
    }
});

// Function to format phone number to E.164
function formatToE164(phone) {
    try {
        const phoneNumber = parsePhoneNumber(phone, 'US');
        return phoneNumber.format('E.164');
    } catch (error) {
        console.error('Error formatting phone number:', error);
        return null;
    }
}

// Function to search, update, or create a record in Airtable
async function upsertAirtableRecord(recordId, formData) {
    const {
        firstName,
        lastName,
        email,
        phone,
        dateId,
        utmId,
        utmSource,
        utmMedium,
        utmCampaign
    } = formData;
    const fullName = `${firstName} ${lastName}`;
    const formattedPhone = formatToE164(phone);
    
    try {
        let existingRecord = null;
        
        // First, try to find the record by phone number (if provided)
        if (formattedPhone) {
            const recordsByPhone = await base('MASTER').select({
                filterByFormula: `{Phone} = '${formattedPhone}'`
            }).firstPage();
            if (recordsByPhone.length > 0) {
                existingRecord = recordsByPhone[0];
            }
        }
        
        // If not found by phone, try to find by email (case-insensitive)
        if (!existingRecord && email) {
            const recordsByEmail = await base('MASTER').select({
                filterByFormula: `LOWER({Email}) = '${email.toLowerCase()}'`
            }).firstPage();
            if (recordsByEmail.length > 0) {
                existingRecord = recordsByEmail[0];
            }
        }
        
        const recordFields = {
            "Full Name": fullName,
            "Email": email,
            "Phone": formattedPhone || '',
            "Virtual Op Night RSVP": true,
            "Demio Date ID": dateId,
            "utmId": utmId,
            "utmSource": utmSource,
            "utmMedium": utmMedium,
            "utmCampaign": utmCampaign,
            "Status": "Virtual Op Night RSVP",
        };
        
        if (existingRecord) {
            // Update existing record
            await base('MASTER').update(existingRecord.id, recordFields);
            return { success: true, message: 'Record updated successfully' };
        } else {
            // Create new record
            await base('MASTER').create([{ fields: recordFields }]);
            return { success: true, message: 'Record created successfully' };
        }
    } catch (error) {
        console.error('Error upserting record in Airtable:', error);
        throw error;
    }
}

// Endpoint to handle the upsert operation
fastify.post('/upsert-record', async (request, reply) => {
    const { recordId, firstName, lastName, email, phone, event: dateId, utmId, utmSource, utmMedium, utmCampaign } = request.body;

    const formData = {
        firstName,
        lastName,
        email,
        phone,
        dateId,
        utmId,
        utmSource,
        utmMedium,
        utmCampaign,
        recordId,
    };

    try {
        const result = await upsertAirtableRecord(recordId, formData);
        reply.send(result);
    } catch (error) {
        reply.status(500).send({ success: false, error: 'Failed to upsert record in Airtable' });
    }
});


fastify.post('/videoask', async (request, reply) => {
    const formData = request.body;

    try {
        const response = await fetch('https://hook.us1.make.com/1d5s9k7bbkbg6jsappglfzn2xg5ird7j', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });

        if (response.ok) {
            reply.send({ success: true, message: 'Application submitted successfully.' });
        } else {
            reply.status(500).send({ success: false, message: 'There was an error submitting your application. Please try again.' });
        }
    } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ success: false, message: 'There was an error submitting your application. Please try again.' });
    }
});

// Function to generate a short link using Short.io API
async function generateShortLink(longUrl) {
    const shortIoApiKey = process.env.SHORT_IO_API_KEY;
    const shortIoDomain = process.env.SHORT_IO_DOMAIN;

    try {
        const response = await axios.post('https://api.short.io/links', {
            domain: shortIoDomain,
            originalURL: longUrl
        }, {
            headers: {
                'Authorization': shortIoApiKey,
                'Content-Type': 'application/json'
            }
        });

        return response.data.shortURL;
    } catch (error) {
        console.error('Error generating short link:', error);
        throw error;
    }
}

// Route to generate the video interview link
fastify.get('/generate-video-interview-link/:recordId', async (request, reply) => {
    const { recordId } = request.params;

    try {
        // Fetch the record data from Airtable
        const record = await base('MASTER').find(recordId);
        const fullName = record.fields['Full Name'];
        const phone = record.fields['Phone'];
        const email = record.fields['Email'];

        // Log the fetched values for debugging
        console.log('Full Name:', fullName);
        console.log('Phone:', phone);
        console.log('Email:', email);

        if (!fullName || !phone) {
            throw new Error('Missing required field(s)');
        }

        // Clean the phone number to contain only numbers
        const cleanedPhone = phone.replace(/\D/g, '');

        // Generate the long URL
        let longUrl = `https://www.videoask.com/f4abpblbc#contact_name=${encodeURIComponent(fullName)}&contact_phone_number=%252B${encodeURIComponent(cleanedPhone)}&recordid=${recordId}`;
        if (email) {
            longUrl += `&contact_email=${encodeURIComponent(email)}`;
        }

        // Generate the short link
        const shortLink = await generateShortLink(longUrl);

        // Update Airtable with the short link
        await updateAirtableRecord(recordId, { "Video Interview Short Link": shortLink });

        // Send the short link along with phone and full name
        reply.send({ shortLink, phone: cleanedPhone, name: fullName });
    } catch (error) {
        console.error('Error generating video interview link:', error);
        reply.status(500).send({ message: 'Failed to generate video interview link' });
    }
});

fastify.post('/fastapplyform', async (request, reply) => {
    // Destructure the request body and immediately trim the values
    const {
        firstName,
        lastName,
        email,
        phone,
        officeRecord,
        utmSource,
        utmMedium,
        utmCampaign
    } = request.body;

    // Trim the values to ensure no accidental spaces are processed
    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    const trimmedOfficeRecord = officeRecord.trim();
    const trimmedUtmSource = utmSource.trim();
    const trimmedUtmMedium = utmMedium.trim();
    const trimmedUtmCampaign = utmCampaign.trim();

    const fullName = `${trimmedFirstName} ${trimmedLastName}`;

    try {
        // Search for existing records by email or phone number
        const existingRecords = await base('MASTER').select({
            filterByFormula: `OR({Email} = '${trimmedEmail}', {Phone} = '${trimmedPhone}')`,
            maxRecords: 1
        }).firstPage();

        if (existingRecords.length > 0) {
            // If a record exists, update it
            const recordId = existingRecords[0].id;
            const updatedRecord = await base('MASTER').update(recordId, {
                'Full Name': fullName,
                'Email': trimmedEmail,
                'Phone': trimmedPhone,
                'Status': 'Fast Track Apply',
                'Office Record': [trimmedOfficeRecord], // Assuming this is an array of IDs
                'utmSource': trimmedUtmSource,
                'utmMedium': trimmedUtmMedium,
                'utmCampaign': trimmedUtmCampaign,
                'Opt In': true,
            });

            return reply.send({ success: true, message: 'Application updated successfully.', record: updatedRecord });
        } else {
            // If no record exists, create a new one
            const createdRecord = await base('MASTER').create([{
                fields: {
                    'Full Name': fullName,
                    'Email': trimmedEmail,
                    'Phone': trimmedPhone,
                    'Status': 'Fast Track Apply',
                    'Office Record': [trimmedOfficeRecord], // Assuming this is an array of IDs
                    'utmSource': trimmedUtmSource,
                    'utmMedium': trimmedUtmMedium,
                    'utmCampaign': trimmedUtmCampaign,
                    'Opt In': true,
                }
            }]);

            return reply.send({ success: true, message: 'Application submitted successfully.', record: createdRecord });
        }
    } catch (error) {
        console.error('Error creating/updating record:', error);
        return reply.status(500).send({ success: false, message: 'Failed to submit application.' });
    }
});


fastify.get('/redirect/:officeId', async (request, reply) => {
    const { officeId } = request.params;

    try {
        const officeRecord = await base('Office Locations').find(officeId);

        if (officeRecord && officeRecord.fields['Fast Track Application']) {
            const redirectUrl = officeRecord.fields['Fast Track Application'];
            return reply.redirect(redirectUrl);
        } else {
            return reply.status(404).send('Office not found or no Fast Track Application URL provided.');
        }
    } catch (error) {
        console.error('Error fetching office data:', error);
        return reply.status(500).send('Failed to fetch office data');
    }
});

fastify.get('/demio_report', async (request, reply) => {
    try {
        return reply.view('/src/pages/demio_report.hbs');
    } catch (error) {
        console.error('Error rendering Demio report page:', error);
        reply.status(500).send({ error: 'Failed to load Demio report page' });
    }
});


fastify.get('/api/demio/event/:eventId/dates', async (request, reply) => {
    try {
        const { eventId } = request.params;
        const eventData = await fetchAllDemioEventData(eventId);
        reply.send(eventData.dates);
    } catch (error) {
        console.error('Error fetching event data:', error);
        reply.status(500).send({ error: 'Failed to retrieve event data' });
    }
});

// Get a record by email
fastify.get('/api/airtable/getRecordByEmailAndDateId', async (request, reply) => {
    const { email, dateId } = request.query;
    console.log(`Searching for Airtable record with email: ${email} and Demio Date ID: ${dateId}`);
    
    if (!email || !dateId) {
        return reply.status(400).send({ error: 'Both email and dateId are required' });
    }

    try {
        const records = await base('MASTER').select({
            filterByFormula: `AND(LOWER({Email}) = LOWER("${email}"), {Demio Date ID} = "${dateId}")`,
            view: 'Demio RSVP'
        }).firstPage();

        console.log(`Found ${records.length} records for email: ${email} and Demio Date ID: ${dateId}`);
        
        if (records.length === 0) {
            console.log(`No record found for email: ${email} and Demio Date ID: ${dateId}`);
            return reply.status(404).send({ error: 'Record not found' });
        }
        
        reply.send(records);
    } catch (error) {
        console.error('Error fetching Airtable record:', error);
        reply.status(500).send({ error: 'Failed to retrieve Airtable record', details: error.message });
    }
});


// Update a record
fastify.post('/api/airtable/updateRecord', async (request, reply) => {
    const { recordId, fields } = request.body;
    console.log(`Updating Airtable record ${recordId} with fields:`, fields);
    try {
        const record = await base('MASTER').update(recordId, fields);
        console.log(`Successfully updated record ${recordId}. Updated fields:`, record.fields);
        reply.send(record);
    } catch (error) {
        console.error(`Error updating Airtable record ${recordId}:`, error);
        reply.status(500).send({ error: 'Failed to update Airtable record', details: error.message });
    }
});
fastify.get('/api/demio/report/:dateId/participants', async (request, reply) => {
    const { dateId } = request.params;
    const { status, limit = 100, offset = 0 } = request.query;
    try {
        console.log(`Fetching participants for dateId: ${dateId}, status: ${status}, limit: ${limit}, offset: ${offset}`);
        const baseUrl = `https://my.demio.com/api/v1/report/${dateId}/participants`;
        const queryParams = new URLSearchParams({
            ...(status && { status }),
            limit: limit.toString(),
            offset: offset.toString()
        }).toString();
        const url = `${baseUrl}?${queryParams}`;

        const headers = {
            'Content-Type': 'application/json',
            'Api-Key': process.env.DEMIO_API_KEY,
            'Api-Secret': process.env.DEMIO_API_SECRET
        };
        console.log('Sending request to Demio API:', url);
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('Received data from Demio API:', JSON.stringify(data, null, 2));

        // Check if we need to fetch more participants
        const totalParticipants = data.total || 0;
        const fetchedParticipants = data.participants.length;
        const hasMore = offset + fetchedParticipants < totalParticipants;

        reply.send({
            participants: data.participants,
            total: totalParticipants,
            hasMore
        });
    } catch (error) {
        console.error('Error fetching participants from Demio:', error);
        reply.status(500).send({ error: 'Failed to retrieve participants', details: error.message });
    }
});

// Function to fetch all Demio event data
async function fetchAllDemioEventData(eventId) {
    const url = `https://my.demio.com/api/v1/event/${eventId}`;
    const headers = {
        'Content-Type': 'application/json',
        'Api-Key': process.env.DEMIO_API_KEY,
        'Api-Secret': process.env.DEMIO_API_SECRET
    };

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching data from Demio:', error);
        throw error;
    }
}

// Function to fetch participants for a given date ID
async function fetchDemioParticipants(dateId, status) {
    const url = `https://my.demio.com/api/v1/report/${dateId}/participants?status=${status}`;
    const headers = {
        'Content-Type': 'application/json',
        'Api-Key': process.env.DEMIO_API_KEY,
        'Api-Secret': process.env.DEMIO_API_SECRET
    };

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data.participants;
    } catch (error) {
        console.error('Error fetching participants from Demio:', error);
        throw error;
    }
}

// Function to update Airtable records based on participant information
async function updateAirtableRecords(participants) {
    for (const participant of participants) {
        const email = participant.email;
        const attended = participant.attended;

        try {
            // Query Airtable for matching record
            const records = await base('MASTER').select({
                filterByFormula: `{Email} = "${email}"`,
                view: 'Demio RSVP'
            }).firstPage();

            if (records.length > 0) {
                const recordId = records[0].id;
                const updateData = {};

                // Update the correct field based on attendance status
                if (attended) {
                    updateData['Attended Opportunity Night'] = true;
                    updateData['Did Not Attend Opportunity Night'] = false;
                } else {
                    updateData['Did Not Attend Opportunity Night'] = true;
                    updateData['Attended Opportunity Night'] = false;
                }

                // Update Airtable record
                await base('MASTER').update(recordId, updateData);
            }
        } catch (error) {
            console.error('Error updating Airtable record:', error);
        }
    }
}

// Webhook endpoint to update attendance information
fastify.post('/webhook/update-attendance', async (request, reply) => {
    try {
        const eventId = request.body.eventId || 'your_default_event_id';
        const eventData = await fetchAllDemioEventData(eventId);

        const currentTime = Date.now();
        const oneWeekAgo = currentTime - (7 * 24 * 60 * 60 * 1000);

        for (const date of eventData.dates) {
            const eventTimestamp = date.timestamp * 1000;
            if (eventTimestamp < currentTime && eventTimestamp >= oneWeekAgo) { // Check if the date is in the past week
                const participants = await fetchDemioParticipants(date.date_id, 'all'); // Fetch all participants regardless of status
                await updateAirtableRecords(participants);
            }
        }

        reply.send({ success: true });
    } catch (error) {
        console.error('Error updating attendance information:', error);
        reply.status(500).send({ error: 'Failed to update attendance information' });
    }
});

// Start the server
const start = async () => {
    try {
        await fastify.listen(3000);
        fastify.log.info(`Server running at http://localhost:3000`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
}
start();

// Endpoint to update the "Notes" field in Airtable
fastify.post('/update-notes', async (request, reply) => {
    const { recordId, firstName, notes } = request.body;
    const currentDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }); // Get current date in MM-DD-YYYY format

    try {
        // Fetch the existing record to get current notes
        const existingRecord = await base('MASTER').find(recordId);
        const existingNotes = existingRecord.fields['Notes'] || ''; // Get existing notes or an empty string

        // Construct the new note with the date stamp
        const newNote = `${firstName}: ${notes} - ${currentDate}`;

        // Append the new note to the existing notes
        const updatedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote;

        // Construct the updated fields object
        const updatedFields = {
            "Notes": updatedNotes
        };

        // Update the Airtable record with the new notes
        const updatedRecord = await updateAirtableRecord(recordId, updatedFields);

        // Send a success response back to the client
        reply.send({ success: true, message: 'Notes updated successfully', data: updatedRecord });
    } catch (error) {
        console.error('Error updating notes:', error);
        // Send an error response back to the client
        reply.status(500).send({ success: false, message: 'Failed to update notes', error: error.message });
    }
});

// Route to serve the peddler request page
fastify.get('/peddler-request', async (request, reply) => {
    try {
        return reply.view('/src/pages/peddler-request.hbs', {});
    } catch (error) {
        console.error('Error rendering Peddler Request page:', error);
        return reply.status(500).send('Error loading Peddler Request page');
    }
});


fastify.post('/request-peddlers', async (request, reply) => {
    try {
        const { immediateSupervisor, permitFor, branch, notes } = request.body;

        // Validate incoming request data
        if (!immediateSupervisor || !permitFor || !branch) {
            return reply.status(400).send({ success: false, error: 'Missing required fields' });
        }

        // Fetch additional data from Airtable using helper function
        const supervisorInfo = await getInformationFromSecondBase('Team Members', immediateSupervisor);
        const permitForInfo = await getInformationFromSecondBase('Team Members', permitFor);
        const branchInfo = await getInformationFromSecondBase('Branch', branch);

        // Check if all necessary information was retrieved successfully
        if (!supervisorInfo || !permitForInfo || !branchInfo) {
            return reply.status(404).send({ success: false, error: 'Failed to retrieve necessary information from Airtable' });
        }

        // Construct the JSON payload
        const payload = {
            immediateSupervisor: {
                id: immediateSupervisor,
                fullName: supervisorInfo.fields['Full Name'],
                email: supervisorInfo.fields['Email'],
                phone: supervisorInfo.fields['Phone'],
                googleUserId: supervisorInfo.fields['Google User ID']
            },
            permitFor: {
                id: permitFor,
                fullName: permitForInfo.fields['Full Name'],
                email: permitForInfo.fields['Email'],
                phone: permitForInfo.fields['Phone'],
                googleUserId: permitForInfo.fields['Google User ID']
            },
            branch: {
                id: branch,
                name: branchInfo.fields['Branch']
            },
            notes: notes || '' // Ensure notes is an empty string if not provided
        };

        // Send the JSON payload to the webhook
        const response = await fetch('https://hook.us1.make.com/9699555kvxynue5e2bifxpmnlyvlzaap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text(); // Capture the error response
            throw new Error(`Failed to send data to the webhook. Status: ${response.status}, Response: ${errorText}`);
        }

        // Redirect to the success page after successful submission
        return reply.redirect('/success-peddler');
    } catch (error) {
        console.error('Error processing request:', error);
        return reply.status(500).send({ success: false, error: error.message });
    }
});

fastify.get('/success-peddler', async (request, reply) => {
    try {
        // Render the success-peddler.hbs template
        return reply.view('/src/pages/success-peddler.hbs');
    } catch (error) {
        console.error('Error rendering success page:', error);
        return reply.status(500).send({ error: 'Failed to load success page' });
    }
});



fastify.get('/onboarding', async (request, reply) => {
    try {
        const records = await base('MASTER').select({
            view: 'Request To Onboard',
            filterByFormula: 'AND(NOT({Hired}), NOT({Disqualified}))'
        }).all();

        // Extract and format Start Dates
        const uniqueStartDates = [...new Set(records
            .map(record => record.fields['Start Date'])
            .filter(Boolean)
            .map(date => {
                const d = new Date(date);
                return d.toLocaleDateString('en-US', {year: 'numeric', month: '2-digit', day: '2-digit'});
            })
        )].sort((a, b) => new Date(b) - new Date(a)); // Sort dates newest to oldest

        const statuses = [...new Set(records.map(record => record.fields['Status']).filter(Boolean))];

        // Extract unique Office Names from the linked 'Office Record' field
        const uniqueOffices = [...new Set(records
            .flatMap(record => record.fields['Office Record'] || [])
            .filter(Boolean)
        )];

        // Fetch office names for the unique office IDs
        const officeRecords = await base('Office Locations').select({
            filterByFormula: `OR(${uniqueOffices.map(id => `RECORD_ID()='${id}'`).join(',')})`
        }).all();

        const officeMap = new Map(officeRecords.map(office => [office.id, office.fields['Name']]));

        const candidates = records.map(record => ({
            id: record.id,
            fullName: record.fields['Full Name'],
            firstName: record.fields['First Name'],
            lastName: record.fields['Last Name'],
            phone: record.fields['Phone'],
            email: record.fields['Email'],
            roleAbbreviation: record.fields['Role Abbreviation'],
            backgroundCheckComplete: record.fields['Background Check Complete'] || false,
            candidatePacketComplete: record.fields['Candidate Packet Complete'] || false,
            backgroundCheckAuthorized: record.fields['Background Check Authorized'] || false,
            onboardingInitiated: record.fields['Onboarding Initiated'] || false,
            onboardingPacketComplete: record.fields['Onboarding Packet Complete'] || false,
            hired: record.fields['Hired'] || false,
            officeName: record.fields['Office Record'] ? officeMap.get(record.fields['Office Record'][0]) : '',
            onboardingRequester: record.fields['Onboarding Requester'],
            referredBy: record.fields['Referred By'],
            startDate: record.fields['Start Date'] ? new Date(record.fields['Start Date']).toLocaleDateString('en-US', {year: 'numeric', month: '2-digit', day: '2-digit'}) : '',
            status: record.fields['Status'],
            gChatUrl: record.fields['GChat Url'],
            freshservicePayload: record.fields['Freshservice Payload'] || '{}'
        }));

        // Sort candidates alphabetically by full name
        candidates.sort((a, b) => a.fullName.localeCompare(b.fullName));

        // Sort office options alphabetically
        const officeOptions = Array.from(officeMap.values()).sort((a, b) => a.localeCompare(b));

        return reply.view('/src/pages/onboarding.hbs', {
            candidates,
            uniqueStartDates,
            officeOptions,
            statuses
        });
    } catch (error) {
        console.error(error);
        reply.status(500).send('Error fetching data');
    }
});



fastify.post('/update-status', async (request, reply) => {
    const { recordId, field, value, status, disqualified, reasonForDisqualification } = request.body;
    if (!recordId) {
        return reply.status(400).send('Record ID is required');
    }
    try {
        let updateFields = {};
        if (field && value !== undefined) {
            updateFields[field] = value;
        }
        if (status) {
            updateFields['Status'] = status;
        } else if (field === 'Onboarding Initiated') {
            updateFields['Status'] = value ? 'Onboarding Initiated' : 'Request To Onboard';
        }

        if (disqualified !== undefined) {
            updateFields['Disqualified'] = disqualified;
        }
        if (reasonForDisqualification) {
            updateFields['Reason For Disqualification'] = reasonForDisqualification;
        }
        // Update the Airtable record
        await base('MASTER').update([
            {
                id: recordId,
                fields: updateFields
            }
        ]);
        return reply.send({ success: true });
    } catch (error) {
        console.error('Error updating record:', error);
        return reply.status(500).send('Failed to update record');
    }
});

fastify.post('/update-freshservice-payload', async (request, reply) => {
    const { recordId, FirstName, LastName, PhoneNumber, EmployeePersonalEmail, StartDate } = request.body;

    try {
        // Fetch the current Freshservice Payload from Airtable
        const record = await base('MASTER').find(recordId);
        let freshservicePayload = JSON.parse(record.fields['Freshservice Payload']);

        // Update the payload with the new values
        freshservicePayload.FirstName = FirstName;
        freshservicePayload.LastName = LastName;
        freshservicePayload.PhoneNumber = PhoneNumber;
        freshservicePayload.EmployeePersonalEmail = EmployeePersonalEmail;
        freshservicePayload.StartDate = new Date(StartDate).toISOString();

        // Update the Airtable record with the new payload
        await base('MASTER').update(recordId, {
            'Freshservice Payload': JSON.stringify(freshservicePayload),
            'Hired': true,
            'Status': 'Hired'
        });

        // Send the updated payload to the Freshservice webhook
        const webhookResponse = await fetch('https://webhooks.workato.com/webhooks/rest/c1e3be47-2099-4e68-b73f-1e7d48994570/fresh-service-onboarding', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(freshservicePayload),
        });

        if (!webhookResponse.ok) {
            throw new Error(`Webhook call failed: ${webhookResponse.statusText}`);
        }

        // Create Trello card with candidate information
        await trelloUtils.createCandidateCard({
            firstName: FirstName,
            lastName: LastName,
            email: EmployeePersonalEmail,
            phone: PhoneNumber,
            startDate: StartDate
        });

        reply.send({ success: true, message: 'Freshservice Payload updated and sent successfully, Trello card created' });
    } catch (error) {
        console.error('Error updating Freshservice Payload or creating Trello card:', error);
        reply.status(500).send({ success: false, message: 'Failed to update Freshservice Payload or create Trello card', error: error.message });
    }
});


fastify.post('/payscale-approval', async (request, reply) => {
  try {
    const formData = request.body;
    
    // Only forward to webhook if approval is required
    if (formData.requiresApproval === true) {
      // Create a copy of the formData to modify
      const modifiedFormData = {...formData};
      
      // If approverEmails is an array, join it with commas AND spaces
      if (Array.isArray(modifiedFormData.approverEmails)) {
        modifiedFormData.approverEmailsString = modifiedFormData.approverEmails.join(', ');
      }
      
      // Send the modified data to the webhook
      const response = await fetch('https://hook.us1.make.com/wgtqt3eqd3oakdof7wwf5xsu2lh2dt5x', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(modifiedFormData)
      });
      
      if (!response.ok) {
        throw new Error(`Webhook response was not ok: ${response.statusText}`);
      }
      
      return reply.code(200).send({ success: true, message: 'Approval request sent successfully' });
    } else {
      // No approval needed, just return success
      return reply.code(200).send({ success: true, message: 'No approval required' });
    }
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

fastify.post('/combined-request-hire-and-org-log-create', async (request, reply) => {
    const { 
        recordId, immediateSupervisorInfo, hiringManagerInfo, startDate, roleInfo, teamInfo, 
        legalFirstName, lastName, email, phone, referredBy, shirtSize, officeRecord 
    } = request.body;

    try {
        // Step 1: Update or Create record in MASTER table
        const directManagerName = immediateSupervisorInfo.name || '';
        const onboardingRequesterName = hiringManagerInfo.name || '';
        const roleAbbreviation = roleInfo.roleAbbrv || '';
        const teamName = teamInfo.name || '';
        const hrRepName = teamInfo.hrRepName && teamInfo.hrRepName.length > 0 ? teamInfo.hrRepName[0] : '';

        const formattedStartDate = moment(startDate).format('YYYY-MM-DD');
        const hiredDate = moment().format('YYYY-MM-DD');

        const freshservicePayload = constructFreshservicePayload(request.body);

        const masterFields = {
            'Status': 'Request To Onboard',
            'Request To Onboard Received': true,
            'Direct Manager': directManagerName,
            'Start Date': formattedStartDate,
            'Hired Date': hiredDate,
            'Onboarding Requester': onboardingRequesterName,
            'Role Abbreviation': roleAbbreviation,
            'Offered': true,
            'Team': teamName,
            'HR Rep': hrRepName,
            'Full Name': `${legalFirstName} ${lastName}`,
            'Email': email,
            'Phone': phone,
            'Freshservice Payload': JSON.stringify(freshservicePayload),
            'Opt In': true,
            'Office Record': officeRecord ? [officeRecord] : [] // Add this line
        };

        let masterResponse;
        let masterRecordId;

        if (recordId) {
            masterResponse = await updateAirtableRecord(recordId, masterFields);
            masterRecordId = recordId;
        } else {
            const existingRecords = await base('MASTER').select({
                filterByFormula: `{Email} = '${email}'`
            }).firstPage();

            if (existingRecords.length > 0) {
                masterRecordId = existingRecords[0].id;
                masterResponse = await updateAirtableRecord(masterRecordId, masterFields);
            } else {
                masterResponse = await base('MASTER').create([{ fields: masterFields }]);
                masterRecordId = masterResponse[0].id;
            }
        }

        // Step 2: Create record in baseSecond
        const cleanPhone = phone.replace(/\D/g, '');
        const orgLogFields = {
            'First Name': legalFirstName,
            'Last Name': lastName,
            'Phone': cleanPhone,
            'Role': roleInfo.roleAbbrv || '',
            'Role Type': roleInfo.roleType || '',
            'Department': roleInfo.department || '',
            'Immediate Supervisor': [immediateSupervisorInfo.id] || '',
            'Area': teamInfo.name || '',
            'Hire Date': formattedStartDate,
            'Position Start Date': formattedStartDate,
            'Region': teamInfo.region || '',
            'Team': teamInfo.team || '',
            'Area': teamInfo.area || '',
            'Branch': teamInfo.branch || '',
            'Manager': teamInfo.manager || '',
            'Area Director': teamInfo.areaDirector || '',
            'Regional Director': teamInfo.regionalDirector || '',
            'Divisional VP': teamInfo.divisionalVp || '',
            'Recruiting ID': masterRecordId,
            'Shirt Size': shirtSize,
            'Personal Email': email,
        };

        if (referredBy) {
            orgLogFields['Recruited By'] = [referredBy];
        }

        const newOrgLogRecord = await createRecordInSecondBase(orgLogFields);
        const orgLogId = newOrgLogRecord.id;

        // Step 3: Update MASTER record with Org Log ID
        await updateAirtableRecord(masterRecordId, { 'Org Log ID': orgLogId });

        reply.send({ 
            success: true, 
            message: 'Records created/updated successfully in both bases', 
            data: { 
                masterRecord: masterResponse,
                orgLogRecord: newOrgLogRecord,
                masterRecordId: masterRecordId,
                orgLogId: orgLogId
            } 
        });

    } catch (error) {
        console.error('Error in combined operation:', error);
        reply.status(500).send({ 
            success: false, 
            message: 'Failed to complete the combined operation', 
            error: error.message 
        });
    }
});

fastify.get('/csv-upload', async (request, reply) => {
  return reply.view('/src/pages/csv-upload.hbs');
});

fastify.post('/upload-csv', async (request, reply) => {
  try {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ message: 'No file uploaded' });
    }

    const csvType = data.fields.csvType ? data.fields.csvType.value : null;
    if (!csvType) {
      return reply.code(400).send({ message: 'Missing CSV type' });
    }

    const filePath = path.join(__dirname, 'uploads', data.filename);
    await pump(data.file, fs.createWriteStream(filePath));

    const processedRecords = await processCSV(filePath, csvType);
    
    if (processedRecords.length === 0) {
      return reply.code(400).send({ message: 'No valid records found in the CSV file' });
    }

    const uploadResult = await uploadToAirtable(processedRecords);

    // Clean up: delete the uploaded file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    reply.code(200).send({ 
      message: 'File processed and uploaded successfully', 
      totalProcessed: uploadResult.totalProcessed,
      created: uploadResult.created,
      updated: uploadResult.updated
    });
  } catch (error) {
    console.error('Error processing file:', error);
    reply.code(500).send({ 
      message: 'Error processing file', 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});



fastify.get("/candidates", async (request, reply) => {
  function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    const month = date.toLocaleString('default', { month: 'short' });
    const day = date.getDate();
    const year = date.getFullYear();
    const suffix = ['th', 'st', 'nd', 'rd'][(day % 10 > 3) ? 0 : (day % 100 - day % 10 != 10) * day % 10];
    return `${month} ${day}${suffix}, ${year}`;
  }

  try {
    const allQualifiedCandidates = await base('MASTER').select({
      filterByFormula: "AND({Opt In} = TRUE(), {Disqualified} = FALSE(), {Hired} = FALSE())"
    }).all();

    const statuses = new Set();
    const officeIds = new Set();

    const candidatesData = allQualifiedCandidates.map(record => {
      const status = record.get('Status');
      statuses.add(status);
      const officeId = record.get('Office Record') ? record.get('Office Record')[0] : '';
      if (officeId) officeIds.add(officeId);

      return {
        firstName: record.get('First Name'),
        lastName: record.get('Last Name'),
        phone: record.get('Phone'),
        email: record.get('Email'),
        attended: record.get('Attended Opportunity Night'),
        recordId: record.id,
        onboardingForm: record.get('Onboarding Request Form Link'),
        status: status,
        leaderEmail: record.get('Opportunity Night Leader Email'),
        leaderName: record.get('Opportunity Night Leader Name'),
        leaderPhone: record.get('Opportunity Night Leader Phone'),
        virtualInterview: record.get('Video Interview Share Link'),
        questionnaireKey: record.get('Questionnaire Score Key'),
        notes: record.get('Notes'),
        dateApplied: formatDate(record.get('Date Applied')),
        office: officeId
      };
    });

    const officeRecords = await base('Office Locations').select({
      filterByFormula: `OR(${Array.from(officeIds).map(id => `RECORD_ID()='${id}'`).join(',')})`
    }).all();

    const officeMap = new Map(officeRecords.map(office => [office.id, office.fields['Name']]));

    const candidatesWithOfficeNames = candidatesData.map(candidate => ({
      ...candidate,
      officeName: officeMap.get(candidate.office) || 'Unknown Office'
    }));

    const uniqueOffices = Array.from(new Set(candidatesWithOfficeNames.map(candidate => candidate.officeName)));

    return reply.view("/src/pages/candidates.hbs", { 
      candidates: candidatesWithOfficeNames, 
      uniqueStatuses: Array.from(statuses),
      uniqueOffices
    });
  } catch (error) {
    console.error('Error fetching data:', error);
    return reply.view("/src/pages/error.hbs", { error: 'Error fetching candidate data' });
  }
});



fastify.get("/new-hire-list", async (request, reply) => {
 try {
   const { startDate, office } = request.query;

   // Get the current week's start (Monday) and end (Sunday) dates
   const now = new Date();
   const currentWeekStart = new Date(now);
   currentWeekStart.setHours(0, 0, 0, 0);
   currentWeekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
   
   const currentWeekEnd = new Date(currentWeekStart);
   currentWeekEnd.setDate(currentWeekStart.getDate() + 6);
   
   // Format dates for Airtable formula
   const startDateToUse = startDate || currentWeekStart.toISOString().split('T')[0];

   const hiredRecords = await base('MASTER').select({
     filterByFormula: "AND({Hired} = TRUE(), {Disqualified} = FALSE())",
     fields: ['Full Name', 'Phone', 'Email', 'Start Date', 'Office Record', 'Role Abbreviation']
   }).all();

   const officeIds = new Set();
   hiredRecords.forEach(record => {
     const officeRecord = record.get('Office Record');
     if (officeRecord && officeRecord.length > 0) {
       officeRecord.forEach(id => officeIds.add(id));
     }
   });

   const officeRecords = await base('Office Locations').select({
     filterByFormula: `OR(${Array.from(officeIds).map(id => `RECORD_ID()='${id}'`).join(',')})`,
     fields: ['Name']
   }).all();

   const officeMap = new Map(officeRecords.map(office => [office.id, office.fields['Name']]));

   // Format the data and apply filters
   let formattedRecords = hiredRecords.map(record => {
     const officeRecord = record.get('Office Record');
     const officeInfo = officeRecord && officeRecord.length > 0 ? {
       id: officeRecord[0],
       name: officeMap.get(officeRecord[0]) || 'Unknown Office'
     } : null;

     const startDateValue = record.get('Start Date');
     const formattedDate = startDateValue ? new Date(startDateValue).toLocaleDateString('en-US', {
       year: 'numeric',
       month: 'long',
       day: 'numeric'
     }) : '';

     return {
       recordId: record.id,
       fullName: record.get('Full Name'),
       phone: record.get('Phone'),
       email: record.get('Email'),
       startDate: formattedDate,
       startDateRaw: startDateValue,
       office: officeInfo,
       roleAbbreviation: record.get('Role Abbreviation') || 'Unassigned'
     };
   });

   // Get unique start dates and format them as week ranges
   const uniqueStartDates = [...new Set(formattedRecords
     .map(record => record.startDateRaw)
     .filter(Boolean)
   )].sort((a, b) => new Date(b) - new Date(a));

   const formattedStartDates = uniqueStartDates.map(date => {
     const dateObj = new Date(date);
     const weekStart = new Date(dateObj);
     weekStart.setDate(dateObj.getDate() - ((dateObj.getDay() + 6) % 7));
     const weekEnd = new Date(weekStart);
     weekEnd.setDate(weekStart.getDate() + 6);

     return {
       value: date,
       label: `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
     };
   });

   // Create unique offices map
   const officesMap = new Map();
   officesMap.set('all', {
     id: 'all',
     name: 'All Offices'
   });

   formattedRecords.forEach(record => {
     if (record.office && record.office.id) {
       officesMap.set(record.office.id, {
         id: record.office.id,
         name: record.office.name
       });
     }
   });

   const uniqueOffices = Array.from(officesMap.values()).sort((a, b) => {
     if (a.id === 'all') return -1;
     if (b.id === 'all') return 1;
     return a.name.localeCompare(b.name);
   });

   // Apply filters
   formattedRecords = formattedRecords.filter(record => {
     if (!record.startDateRaw) return false;
     
     const recordDate = new Date(record.startDateRaw);
     const recordWeekStart = new Date(recordDate);
     recordWeekStart.setDate(recordDate.getDate() - ((recordDate.getDay() + 6) % 7));
     
     const filterDate = new Date(startDateToUse);
     const filterWeekStart = new Date(filterDate);
     filterWeekStart.setDate(filterDate.getDate() - ((filterDate.getDay() + 6) % 7));
     
     return recordWeekStart.getTime() === filterWeekStart.getTime();
   });

   if (office && office !== 'all') {
     formattedRecords = formattedRecords.filter(record => 
       record.office && record.office.id === office
     );
   }

   // Group records by role abbreviation
   const groupedRecords = {};
   formattedRecords.forEach(record => {
     const role = record.roleAbbreviation;
     if (!groupedRecords[role]) {
       groupedRecords[role] = [];
     }
     groupedRecords[role].push(record);
   });

   // Sort records within each group alphabetically by full name
   Object.keys(groupedRecords).forEach(role => {
     groupedRecords[role].sort((a, b) => a.fullName.localeCompare(b.fullName));
   });

   // Sort the roles alphabetically
   const sortedGroups = Object.keys(groupedRecords).sort().reduce(
     (obj, key) => { 
       obj[key] = groupedRecords[key]; 
       return obj;
     }, 
     {}
   );

   return reply.view("/src/pages/new-hire-list.hbs", { 
     groupedRecords: sortedGroups,
     startDates: formattedStartDates,
     offices: uniqueOffices,
     selectedStartDate: startDateToUse,
     selectedOffice: office || 'all',
     pageTitle: "New Hire List"
   });

 } catch (error) {
   console.error('Error fetching new hire data:', error);
   return reply.view("/src/pages/error.hbs", { 
     error: 'Error fetching new hire data' 
   });
 }
});