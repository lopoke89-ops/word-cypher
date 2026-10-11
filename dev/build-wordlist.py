# Rebuilds ../words.txt. Needs, inside dev/build/:
#   words.txt                       from the npm package word-list (MIT)
#   ud/data/*.data                  from github.com/mattbierner/urban-dictionary-word-list (MIT)
#   dl/node_modules/random-name/*   from the npm package random-name (names to filter out)
# Most of the time you don't need this: to add a slang word, just add a line '!word' to ../words.txt.
import glob,re,collections,sys
import os
base=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build')+'/'
ph=collections.Counter(); titles=set()
for f in glob.glob(base+'ud/data/*.data'):
    for line in open(f,encoding='utf-8',errors='ignore'):
        s=line.strip().lower()
        if re.fullmatch(r'[a-z]{2,15}',s): titles.add(s)
        for t in re.findall(r'[a-z]+',s): ph[t]+=1
dic={l.strip() for l in open(base+'words.txt') if re.fullmatch(r'[a-z]{2,15}',l.strip())}
names=set()
for fn in ['first-names','middle-names','names','places']:
    names|={l.strip().lower() for l in open(base+f'dl/node_modules/random-name/{fn}.txt')}
ud={w for w in titles if ph[w]>=15 and len(w)>=3 and re.search('[aeiouy]',w)}-names
cur={l.strip() for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'slang.txt')) if l.strip()}
ud|=cur
# keep hateful slurs off the board (UD only)
block=re.compile(r'^(n[i1]gg(a|er|ah|uh|az|ers|as)?s?|niglet|fagg?(ot|it|y)?s?|f[a@]g|dykes?|trann(y|ie)s?|kikes?|spics?|chinks?|wetbacks?|gooks?|coons?|retards?|beaners?|towelheads?|sandn\w+|raghead\w*|jiggaboo\w*|porchmonkey\w*|shemales?|pakis?|chinks?|zipperheads?|gypp?os?)$')
ud={w for w in ud if not block.match(w)}
udonly=ud-dic
out=sorted(dic|udonly)
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','words.txt'),'w') as fh:
    fh.write('\n'.join((('!' if w in cur else '*')+w if w in udonly else w) for w in out))
print(len(dic),len(udonly),len(out))
