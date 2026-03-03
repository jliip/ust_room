
## First step
UST class schedule and description link:
https://w5.ab.ust.hk/wcq/cgi-bin/2540/
I hope you can use python or any other climb method to collect the data of the room, time and course, and manage it into a fit dataset form
For example, in the subpage of 2025-2026 spring semester, ISDN 1004 is:

ISDN 1004 - Sketching (1 unit)

Section	Date & Time	Room	Instructor	TA/IA/GTA	Quota	Enrol	Avail	Wait	Remarks
LA1 (2927)	WeFr 03:00PM - 04:20PM	Rm 2590, Lift 27-28	
LAU, Brian Hui Wang
30	28	2	0	
LA2 (2928)	MoWe 12:00PM - 01:20PM	Rm 2590, Lift 27-28	
LAU, Brian Hui Wang
30	28	2	0	

The dataset need to good collect those data

## Second step
After that, we need to tranfer the data into a front-end page to show. 
This website to targeting to provide a easy way for ust student to find a empty room to study or sit down. Atfer check this web, I hope they could see the room name, and the room's using or not. List all the room and divided they into two sort list, one using, one empty. After student click or search a detailed room, they are able to see the whole day schdule of the room. Like a timeline or any way you think is good to look.



## Run
pip install -r requirements.txt
python scraper.py          # generates data/schedule.json (takes a few minutes)
python -m http.server 8000
# → open http://localhost:8000/index.html
