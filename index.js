const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const fs = require('fs');
const cheerio = require('cheerio');
const { isEmail } = require('validator');
const puppeteer = require('puppeteer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('Failed to connect to MongoDB', err);
});

const hotelSchema = new mongoose.Schema({
  name: String,
  address: String,
  website_url: String,
  rating: Number,
  place_id: String,
  photo_url: String,
  email: String,
});

const Hotel = mongoose.model('Hotel', hotelSchema);

let apiCallCount = 0;
const MAX_API_CALLS = 5000;

app.get('/fetch_hotels/:city', async (req, res) => {
  const city = req.params.city;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (apiCallCount >= MAX_API_CALLS) {
    console.log('API call limit reached');
    return res.status(429).send('API call limit reached');
  }

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=hotels+hostels+in+${city}+France&key=${apiKey}`;

  console.time('fetchingHotelData');

  try {
    console.log('Making initial API call to Google Places Text Search API');
    const response = await axios.get(url);
    apiCallCount++;
    console.log(`Initial API call complete. API call count: ${apiCallCount}`);
    console.log('Response data:', response.data);

    if (response.data.status !== 'OK') {
      console.error('Error fetching data from Google Places API:', response.data.status);
      return res.status(500).send('Error fetching data from Google Places API');
    }

    let places = response.data.results;
    places = places.slice(0, 10); // Adjust the number of places to process as needed
    console.log(`Processing ${places.length} places`);

    const hotelPromises = places.map(async (place) => {
      if (apiCallCount >= MAX_API_CALLS) {
        console.log('API call limit reached during details fetching');
        return null;
      }

      console.log(`Fetching details for place_id: ${place.place_id}`);
      const placeDetailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&key=${apiKey}`;
      const placeDetailsResponse = await axios.get(placeDetailsUrl);
      apiCallCount++;
      console.log(`Fetched details for place_id: ${place.place_id}. API call count: ${apiCallCount}`);
      
      const details = placeDetailsResponse.data.result;
      
      let photoUrl = '';
      if (details.photos && details.photos.length > 0) {
        const photoReference = details.photos[0].photo_reference;
        photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoReference}&key=${apiKey}`;
      }

      const hotel = new Hotel({
        name: details.name,
        address: details.formatted_address,
        website_url: details.website || '',
        rating: details.rating || 0,
        place_id: details.place_id,
        photo_url: photoUrl,
      });

      // Scraping business email from the hotel website using Puppeteer
      const email = await fetchBusinessEmail(details.website);
      console.log(`Scraped email for ${details.name}: ${email}`);
      hotel.email = email !== null ? email : 'null';

      await hotel.save();
      console.log(`Saved hotel: ${details.name}`);
      return hotel;
    });

    const savedHotels = await Promise.all(hotelPromises);
    const filteredHotels = savedHotels.filter(hotel => hotel !== null);

    console.timeEnd('fetchingHotelData');

    // Save the fetched data as an Excel file
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Hotels');

    worksheet.columns = [
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Address', key: 'address', width: 50 },
      { header: 'Website URL', key: 'website_url', width: 50 },
      { header: 'Rating', key: 'rating', width: 10 },
      { header: 'Place ID', key: 'place_id', width: 20 },
      { header: 'Photo URL', key: 'photo_url', width: 50 },
      { header: 'Email', key: 'email', width: 30 },
    ];

    filteredHotels.forEach(hotel => {
      worksheet.addRow({
        name: hotel.name,
        address: hotel.address,
        website_url: hotel.website_url,
        rating: hotel.rating,
        place_id: hotel.place_id,
        photo_url: hotel.photo_url,
        email: hotel.email,
      });
    });

    const filePath = `./${city}_hotels.xlsx`;

    await workbook.xlsx.writeFile(filePath);
    console.log(`Excel file created: ${filePath}`);

    res.download(filePath, `${city}_hotels.xlsx`, (err) => {
      if (err) {
        console.error('Error sending file:', err);
        return res.status(500).send('Error sending file');
      }
      fs.unlinkSync(filePath); // Delete the file after sending
      console.log(`Excel file deleted: ${filePath}`);
    });

    console.log(`Request processing complete for city: ${city}`);
  } catch (error) {
    console.error('Error occurred:', error);
    console.timeEnd('fetchingHotelData');
    res.status(500).send('An error occurred while fetching hotel data.');
  }
});

async function fetchBusinessEmail(websiteUrl) {
  try {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded' });
    const content = await page.content();
    const $ = cheerio.load(content);
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
    const email = $('body').text().match(emailRegex);
    await browser.close();
    if (email && isEmail(email[0])) {
      return email[0];
    }
    return null;
  } catch (error) {
    console.error('Error scraping website:', error);
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
